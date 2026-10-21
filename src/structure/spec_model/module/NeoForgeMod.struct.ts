import StreamZip from 'node-stream-zip'
import toml from 'toml'
import { Type } from 'helios-distribution-types'
import { capitalize } from '../../../util/StringUtils.js'
import { MinecraftVersion } from '../../../util/MinecraftVersion.js'
import { UntrackedFilesOption } from '../../../model/nebula/ServerMeta.js'
import { BaseModStructure } from './Mod.struct.js'

interface NeoForgeModMetadata {
    id: string
    name: string
    version: string
}

/**
 * NeoForge mod distribution, deliberately retaining the historical `forgemods`
 * folders and the `ForgeMod` module type used by Helios Core 2.3.x.
 *
 * ForgeMod modules are downloaded to Helios' modstore and included in the
 * --fml.modLists file by Bedragoth-NeoForge's existing ProcessBuilder.
 * The three namespaces are interpreted by ToggleableModuleStructure.
 *
 * Do not use Claritas' Forge parser here: native NeoForge jars often have
 * META-INF/neoforge.mods.toml instead of META-INF/mods.toml.
 */
export class NeoForgeModStructure extends BaseModStructure<NeoForgeModMetadata> {

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        minecraftVersion: MinecraftVersion,
        untrackedFiles: UntrackedFilesOption[]
    ) {
        super(
            absoluteRoot,
            relativeRoot,
            'forgemods',
            baseUrl,
            minecraftVersion,
            Type.ForgeMod,
            untrackedFiles,
            (name: string) => name.toLowerCase().endsWith('.jar')
        )
    }

    public getLoggerName(): string {
        return 'NeoForgeModStructure'
    }

    protected async getModuleId(name: string, path: string): Promise<string> {
        const metadata = await this.getModMetadata(name, path)
        return this.generateMavenIdentifier('generated.neoforgemod', metadata.id, metadata.version)
    }

    protected async getModuleName(name: string, path: string): Promise<string> {
        return capitalize((await this.getModMetadata(name, path)).name)
    }

    private readJarEntry(zip: StreamZip, filename: string): string | null {
        try {
            return zip.entryDataSync(filename).toString('utf8')
        } catch {
            return null
        }
    }

    private getManifestVersion(zip: StreamZip): string | null {
        const manifest = this.readJarEntry(zip, 'META-INF/MANIFEST.MF')
        if (!manifest) return null
        const match = /^Implementation-Version:\s*(.+?)\s*$/mi.exec(manifest)
        return match ? match[1].trim() : null
    }

    protected processZip(zip: StreamZip, name: string): NeoForgeModMetadata {
        const inferred = this.attemptCrudeInference(name)
        const fallbackId = inferred.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_')
        let id = fallbackId
        let displayName = inferred.name
        let version = inferred.version
        let foundMetadata = false

        const tomlText = this.readJarEntry(zip, 'META-INF/neoforge.mods.toml')
            ?? this.readJarEntry(zip, 'META-INF/mods.toml')
        if (tomlText !== null) {
            try {
                const parsed = toml.parse(tomlText) as {
                    mods?: {modId?: string, version?: string, displayName?: string}[]
                }
                const primary = parsed.mods?.[0]
                if (primary?.modId) {
                    id = primary.modId
                    displayName = primary.displayName || primary.modId
                    version = primary.version || version
                    foundMetadata = true
                } else {
                    this.logger.warn(`Missing [[mods]]/modId in ${name}; inferring metadata from filename.`)
                }
            } catch (error) {
                throw new Error(`Invalid NeoForge/Forge TOML metadata in ${name}.`, { cause: error })
            }
        } else {
            // Connector may host Fabric-only mods in the same distribution.
            const fabricText = this.readJarEntry(zip, 'fabric.mod.json')
            if (fabricText !== null) {
                try {
                    const fabric = JSON.parse(fabricText) as {id?: string, name?: string, version?: string}
                    if (fabric.id) {
                        id = fabric.id
                        displayName = fabric.name || fabric.id
                        version = fabric.version || version
                        foundMetadata = true
                    }
                } catch (error) {
                    throw new Error(`Invalid fabric.mod.json metadata in ${name}.`, { cause: error })
                }
            }
        }

        if (!foundMetadata) {
            this.logger.warn(`No usable mod metadata found in ${name}; using filename-derived identifier.`)
        }
        // NeoForge commonly uses the placeholder ${file.jarVersion} in its TOML.
        if (!version || version.includes('${') || version.includes('@')) {
            version = this.getManifestVersion(zip) || inferred.version || this.DEFAULT_VERSION
        }
        // A Maven identifier must remain valid for Helios Core's modstore.
        if (!/^[a-z0-9_.-]+$/.test(id)) {
            throw new Error(`Invalid mod id '${id}' in ${name}.`)
        }
        if (/[:\\/\s]/.test(version)) {
            throw new Error(`Invalid version '${version}' in ${name}.`)
        }

        const metadata = { id, name: displayName, version }
        this.modMetadata[name] = metadata
        return metadata
    }
}
