import StreamZip from 'node-stream-zip'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { lstat, readFile, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { copy, mkdirs, pathExists, remove, writeJson } from 'fs-extra/esm'
import { Module, Type } from 'helios-distribution-types'
import { BaseResolver } from '../BaseResolver.js'
import { MinecraftVersion } from '../../util/MinecraftVersion.js'
import { RepoStructure } from '../../structure/repo/Repo.struct.js'
import { LibRepoStructure } from '../../structure/repo/LibRepo.struct.js'
import { LoggerUtil } from '../../util/LoggerUtil.js'
import { MavenUtil } from '../../util/MavenUtil.js'
import { VersionManifestNeoForge } from '../../model/neoforge/VersionManifestNeoForge.js'
import { JavaUtil } from '../../util/java/JavaUtil.js'

/**
 * NeoForge 1.21.1 resolver for Helios/Nebula.
 *
 * helios-distribution-types 1.3.0 does not expose a NeoForge module type.
 * The universal NeoForge jar is therefore exposed as ForgeHosted so
 * helios-core 2.3.x can locate the nested VersionManifest. The generated
 * NeoForge client patch and the NeoForm SRG/extra client artifacts remain
 * off the Java classpath. FML ProductionClientProvider locates all three
 * in the library directory and assembles them into the Minecraft game module.
 */
export class NeoForgeResolver extends BaseResolver {

    private static readonly logger = LoggerUtil.getLogger('NeoForge Resolver')
    private static readonly installerLogger = LoggerUtil.getLogger('NeoForge Installer')
    private static readonly REMOTE_REPOSITORY = 'https://maven.neoforged.net/releases/'

    private readonly repoStructure: RepoStructure

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        private minecraftVersion: MinecraftVersion,
        private neoforgeVersion: string,
        private discardOutput: boolean,
        private invalidateCache: boolean
    ) {
        super(absoluteRoot, relativeRoot, baseUrl)
        this.repoStructure = new RepoStructure(absoluteRoot, relativeRoot, 'neoforge')
    }

    public isForVersion(version: MinecraftVersion, libraryVersion: string): boolean {
        return version.toString() === '1.21.1' && libraryVersion.startsWith('21.1.')
    }

    public async getModule(): Promise<Module> {
        if (!this.isForVersion(this.minecraftVersion, this.neoforgeVersion)) {
            throw new Error(`Unsupported NeoForge combination: Minecraft ${this.minecraftVersion}, NeoForge ${this.neoforgeVersion}`)
        }

        await this.repoStructure.init()

        const installerPath = await this.ensureInstaller()
        const manifestBuffer = await this.getVersionManifestFromInstaller(installerPath)
        const manifest = JSON.parse(manifestBuffer.toString('utf8')) as VersionManifestNeoForge
        this.validateManifest(manifest)

        const neoFormVersion = this.getGameArgument(manifest, '--fml.neoFormVersion')
        if (!neoFormVersion) {
            throw new Error(`NeoForge ${this.neoforgeVersion} version.json does not declare --fml.neoFormVersion.`)
        }

        const generatedModules = await this.processInstallerOutputs(installerPath, neoFormVersion)
        const versionManifestModule = await this.writeVersionManifest(manifest, manifestBuffer)
        const libraries = await this.processManifestLibraries(manifest)
        const neoforgeModule = await this.processUniversalJar()

        neoforgeModule.subModules = [
            versionManifestModule,
            ...generatedModules,
            ...libraries
        ]

        if (this.discardOutput) {
            const cacheDir = this.repoStructure.getNeoForgeCacheDirectory(this.getCacheKey())
            NeoForgeResolver.logger.info(`Removing NeoForge installer output at ${cacheDir}..`)
            await remove(cacheDir)
            NeoForgeResolver.logger.info('Removed NeoForge installer output successfully.')
        }

        return neoforgeModule
    }

    private getCacheKey(): string {
        return `${this.minecraftVersion}-${this.neoforgeVersion}`
    }

    private async ensureInstaller(): Promise<string> {
        const libRepo = this.repoStructure.getLibRepoStruct()
        const installerPath = libRepo.getLocalNeoForge(this.neoforgeVersion, 'installer')

        if (this.invalidateCache && await pathExists(installerPath)) {
            await remove(installerPath)
        }

        if (!await pathExists(installerPath)) {
            NeoForgeResolver.logger.info(`Downloading NeoForge ${this.neoforgeVersion} installer...`)
            await libRepo.downloadArtifactByComponents(
                NeoForgeResolver.REMOTE_REPOSITORY,
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.neoforgeVersion,
                'installer',
                'jar'
            )
        }

        return installerPath
    }

    private validateManifest(manifest: VersionManifestNeoForge): void {
        if (!manifest.id || !manifest.mainClass || !manifest.inheritsFrom || !manifest.arguments || !Array.isArray(manifest.libraries)) {
            throw new Error('NeoForge installer contains an invalid or unsupported version.json.')
        }
        if (manifest.inheritsFrom !== this.minecraftVersion.toString()) {
            throw new Error(`NeoForge ${this.neoforgeVersion} targets Minecraft ${manifest.inheritsFrom}, not ${this.minecraftVersion}.`)
        }
        if (!manifest.id.toLowerCase().includes('neoforge')) {
            throw new Error(`Unexpected NeoForge version manifest id: ${manifest.id}`)
        }
    }

    private async getVersionManifestFromInstaller(installerPath: string): Promise<Buffer> {
        const zip = new StreamZip.async({ file: installerPath })
        try {
            return await zip.entryData('version.json')
        } catch (err) {
            throw new Error(`Failed to find version.json in NeoForge installer ${installerPath}.`, { cause: err })
        } finally {
            await zip.close()
        }
    }

    private getGameArgument(manifest: VersionManifestNeoForge, name: string): string | null {
        const args = manifest.arguments.game ?? []
        for (let i = 0; i < args.length - 1; i++) {
            if (args[i] === name && typeof args[i + 1] === 'string') {
                return args[i + 1] as string
            }
        }
        return null
    }

    private async processInstallerOutputs(installerPath: string, neoFormVersion: string): Promise<Module[]> {
        const cacheDir = this.repoStructure.getNeoForgeCacheDirectory(this.getCacheKey())
        const cacheLibraries = join(cacheDir, 'libraries')

        const minecraftClientVersion = `${this.minecraftVersion}-${neoFormVersion}`
        const srgRelative = MavenUtil.mavenComponentsAsPath(
            LibRepoStructure.MINECRAFT_GROUP,
            LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
            minecraftClientVersion,
            'srg'
        )
        const extraRelative = MavenUtil.mavenComponentsAsPath(
            LibRepoStructure.MINECRAFT_GROUP,
            LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
            minecraftClientVersion,
            'extra'
        )
        const neoforgeClientRelative = MavenUtil.mavenComponentsAsPath(
            LibRepoStructure.NEOFORGE_GROUP,
            LibRepoStructure.NEOFORGE_ARTIFACT,
            this.neoforgeVersion,
            'client'
        )

        const extraSource = resolve(cacheLibraries, extraRelative)
        let srgSource = resolve(cacheLibraries, srgRelative)
        let neoforgeClientSource = resolve(cacheLibraries, neoforgeClientRelative)

        if (this.invalidateCache && await pathExists(cacheDir)) {
            await remove(cacheDir)
            srgSource = resolve(cacheLibraries, srgRelative)
            neoforgeClientSource = resolve(cacheLibraries, neoforgeClientRelative)
        }

        if (!await pathExists(srgSource) || !await pathExists(extraSource) || !await pathExists(neoforgeClientSource)) {
            await remove(cacheDir)
            await mkdirs(cacheDir)
            await writeJson(join(cacheDir, 'launcher_profiles.json'), { profiles: {} }, { spaces: 2 })

            NeoForgeResolver.logger.info(`Running NeoForge ${this.neoforgeVersion} client installer processors...`)
            NeoForgeResolver.logger.info(`Installer output: ${cacheDir}`)
            await this.executeInstaller(installerPath, cacheDir)

            srgSource = resolve(cacheLibraries, srgRelative)
            neoforgeClientSource = resolve(cacheLibraries, neoforgeClientRelative)
        } else {
            NeoForgeResolver.logger.info(`Using cached NeoForge installer outputs at ${cacheDir}.`)
        }

        const missing: string[] = []
        if (!await pathExists(srgSource)) {
            missing.push(srgSource)
        }
        if (!await pathExists(extraSource)) {
            missing.push(extraSource)
        }
        if (!await pathExists(neoforgeClientSource)) {
            missing.push(neoforgeClientSource)
        }
        if (missing.length > 0) {
            throw new Error(
                `NeoForge installer finished but required client outputs were not produced:\n\t${missing.join('\n\t')}`
            )
        }

        const libRepo = this.repoStructure.getLibRepoStruct()
        const srgDestination = libRepo.getArtifactByComponents(
            LibRepoStructure.MINECRAFT_GROUP,
            LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
            minecraftClientVersion,
            'srg'
        )
        const extraDestination = libRepo.getArtifactByComponents(
            LibRepoStructure.MINECRAFT_GROUP,
            LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
            minecraftClientVersion,
            'extra'
        )
        const neoforgeClientDestination = libRepo.getArtifactByComponents(
            LibRepoStructure.NEOFORGE_GROUP,
            LibRepoStructure.NEOFORGE_ARTIFACT,
            this.neoforgeVersion,
            'client'
        )

        await mkdirs(dirname(srgDestination))
        await mkdirs(dirname(neoforgeClientDestination))
        await copy(srgSource, srgDestination, { overwrite: true })
        await copy(extraSource, extraDestination, { overwrite: true })
        await copy(neoforgeClientSource, neoforgeClientDestination, { overwrite: true })

        const extraBuffer = await readFile(extraDestination)
        const srgBuffer = await readFile(srgDestination)
        const neoforgeClientBuffer = await readFile(neoforgeClientDestination)

        return [
            {
                id: MavenUtil.mavenComponentsToIdentifier(
                    LibRepoStructure.MINECRAFT_GROUP,
                    LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
                    minecraftClientVersion,
                    'srg'
                ),
                name: `Minecraft ${this.minecraftVersion} NeoForm SRG client`,
                type: Type.Library,
                // FML locates this directly from the library directory.
                classpath: false,
                artifact: this.generateArtifact(
                    srgBuffer,
                    await lstat(srgDestination),
                    libRepo.getArtifactUrlByComponents(
                        this.baseUrl,
                        LibRepoStructure.MINECRAFT_GROUP,
                        LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
                        minecraftClientVersion,
                        'srg'
                    )
                )
            },
            {
                id: MavenUtil.mavenComponentsToIdentifier(
                    LibRepoStructure.MINECRAFT_GROUP,
                    LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
                    minecraftClientVersion,
                    'extra'
                ),
                name: `Minecraft ${this.minecraftVersion} NeoForm extra client resources`,
                type: Type.Library,
                // FML locates this directly from the library directory.
                classpath: false,
                artifact: this.generateArtifact(
                    extraBuffer,
                    await lstat(extraDestination),
                    libRepo.getArtifactUrlByComponents(
                        this.baseUrl,
                        LibRepoStructure.MINECRAFT_GROUP,
                        LibRepoStructure.MINECRAFT_CLIENT_ARTIFACT,
                        minecraftClientVersion,
                        'extra'
                    )
                )
            },
            {
                id: MavenUtil.mavenComponentsToIdentifier(
                    LibRepoStructure.NEOFORGE_GROUP,
                    LibRepoStructure.NEOFORGE_ARTIFACT,
                    this.neoforgeVersion,
                    'client'
                ),
                name: `Minecraft NeoForge ${this.neoforgeVersion} client patch`,
                type: Type.Library,
                // FML overlays these patched classes onto the SRG/extra game module.
                classpath: false,
                artifact: this.generateArtifact(
                    neoforgeClientBuffer,
                    await lstat(neoforgeClientDestination),
                    libRepo.getArtifactUrlByComponents(
                        this.baseUrl,
                        LibRepoStructure.NEOFORGE_GROUP,
                        LibRepoStructure.NEOFORGE_ARTIFACT,
                        this.neoforgeVersion,
                        'client'
                    )
                )
            }
        ]
    }

    private executeInstaller(installerPath: string, outputDir: string): Promise<void> {
        return new Promise((resolvePromise, rejectPromise) => {
            const javaExecutable = JavaUtil.getJavaExecutable()
            if (!javaExecutable) {
                rejectPromise(new Error('JAVA_EXECUTABLE is not configured. NeoForge 1.21.1 generation requires Java 21.'))
                return
            }

            const child = spawn(javaExecutable, [
                '-jar',
                installerPath,
                '--install-client',
                outputDir
            ], {
                cwd: outputDir
            })

            child.stdout.on('data', data => NeoForgeResolver.installerLogger.info(data.toString('utf8').trim()))
            child.stderr.on('data', data => NeoForgeResolver.installerLogger.info(data.toString('utf8').trim()))
            child.on('error', err => rejectPromise(new Error('Failed to start the NeoForge installer.', { cause: err })))
            child.on('close', code => {
                if (code === 0) {
                    NeoForgeResolver.installerLogger.info('NeoForge installer exited successfully.')
                    resolvePromise()
                } else {
                    rejectPromise(new Error(`NeoForge installer exited with code ${code}.`))
                }
            })
        })
    }

    private async writeVersionManifest(manifest: VersionManifestNeoForge, manifestBuffer: Buffer): Promise<Module> {
        const versionRepo = this.repoStructure.getVersionRepoStruct()
        const destination = versionRepo.getNamedVersionManifest(manifest.id)
        await mkdirs(dirname(destination))
        await writeFile(destination, manifestBuffer)

        return {
            id: manifest.id,
            name: `Minecraft NeoForge (${manifest.id} version.json)`,
            type: Type.VersionManifest,
            artifact: this.generateArtifact(
                manifestBuffer,
                await lstat(destination),
                versionRepo.getNamedVersionManifestURL(this.baseUrl, manifest.id)
            )
        }
    }

    private async processUniversalJar(): Promise<Module> {
        const libRepo = this.repoStructure.getLibRepoStruct()
        const universalPath = libRepo.getLocalNeoForge(this.neoforgeVersion, 'universal')

        if (this.invalidateCache && await pathExists(universalPath)) {
            await remove(universalPath)
        }

        if (!await pathExists(universalPath)) {
            NeoForgeResolver.logger.info(`Downloading NeoForge ${this.neoforgeVersion} universal jar...`)
            await libRepo.downloadArtifactByComponents(
                NeoForgeResolver.REMOTE_REPOSITORY,
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.neoforgeVersion,
                'universal',
                'jar'
            )
        }

        const buf = await readFile(universalPath)
        return {
            id: MavenUtil.mavenComponentsToIdentifier(
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.neoforgeVersion,
                'universal'
            ),
            name: `Minecraft NeoForge ${this.neoforgeVersion}`,
            // Compatibility alias for helios-core 2.3.x.
            type: Type.ForgeHosted,
            // NeoForge's universal jar must stay in the library directory for
            // FML's PathBasedLocator. It must not be inserted into the legacy
            // Java classpath by Helios, otherwise BootstrapLauncher consumes it
            // before NeoForge mod discovery can register it as the neoforge mod.
            classpath: false,
            artifact: this.generateArtifact(
                buf,
                await lstat(universalPath),
                libRepo.getArtifactUrlByComponents(
                    this.baseUrl,
                    LibRepoStructure.NEOFORGE_GROUP,
                    LibRepoStructure.NEOFORGE_ARTIFACT,
                    this.neoforgeVersion,
                    'universal',
                    'jar'
                )
            ),
            subModules: []
        }
    }

    private async processManifestLibraries(manifest: VersionManifestNeoForge): Promise<Module[]> {
        const libRepo = this.repoStructure.getLibRepoStruct()
        const modules: Module[] = []
        const modulePathEntries = this.getModulePathEntries(manifest)

        for (const entry of manifest.libraries) {
            const artifact = entry.downloads?.artifact
            if (!artifact?.url || !artifact.path) {
                continue
            }

            // The universal jar is our root ForgeHosted compatibility module.
            if (entry.name === MavenUtil.mavenComponentsToIdentifier(
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.neoforgeVersion,
                'universal'
            )) {
                continue
            }

            const components = MavenUtil.getMavenComponents(entry.name)
            const normalizedArtifactPath = artifact.path.replace(/\\/g, '/')
            const localPath = resolve(libRepo.getContainerDirectory(), normalizedArtifactPath)

            let shouldDownload = !await pathExists(localPath)
            if (!shouldDownload && artifact.sha1) {
                const current = await readFile(localPath)
                shouldDownload = createHash('sha1').update(current).digest('hex') !== artifact.sha1.toLowerCase()
            }

            if (shouldDownload) {
                await remove(localPath)
                NeoForgeResolver.logger.debug(`Downloading ${entry.name}...`)
                await libRepo.downloadArtifactDirect(artifact.url, artifact.path)
            }

            const buf = await readFile(localPath)
            if (artifact.sha1) {
                const actualSha1 = createHash('sha1').update(buf).digest('hex')
                if (actualSha1 !== artifact.sha1.toLowerCase()) {
                    throw new Error(`SHA-1 mismatch for NeoForge library ${entry.name}.`)
                }
            }

            const moduleArtifact = this.generateArtifact(
                buf,
                await lstat(localPath),
                libRepo.getArtifactUrlByPath(this.baseUrl, normalizedArtifactPath)
            )
            moduleArtifact.path = normalizedArtifactPath

            modules.push({
                id: entry.name,
                name: `NeoForge Library (${components.artifact})`,
                type: Type.Library,
                classpath: !modulePathEntries.has(normalizedArtifactPath),
                artifact: moduleArtifact
            })
        }

        return modules
    }

    private getModulePathEntries(manifest: VersionManifestNeoForge): Set<string> {
        const result = new Set<string>()
        const jvmText = (manifest.arguments.jvm ?? [])
            .filter((arg): arg is string => typeof arg === 'string')
            .join('\n')
            .replace(/\\/g, '/')

        for (const entry of manifest.libraries) {
            const path = entry.downloads?.artifact?.path?.replace(/\\/g, '/')
            if (path && jvmText.includes(path)) {
                result.add(path)
            }
        }
        return result
    }
}
