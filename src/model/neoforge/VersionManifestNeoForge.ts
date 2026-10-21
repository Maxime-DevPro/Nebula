export interface NeoForgeManifestArtifact {
    path: string
    url: string
    sha1?: string
    size?: number
}

export interface NeoForgeManifestLibrary {
    name: string
    downloads?: {
        artifact?: NeoForgeManifestArtifact
    }
}

export interface VersionManifestNeoForge {
    id: string
    time?: string
    releaseTime?: string
    type?: string
    mainClass: string
    inheritsFrom: string
    arguments: {
        game: unknown[]
        jvm?: unknown[]
    }
    libraries: NeoForgeManifestLibrary[]
}
