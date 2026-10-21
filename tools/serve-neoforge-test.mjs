import { createReadStream, promises as fs } from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', 'test-distribution')
const host = '127.0.0.1'
const port = 8080

const mime = {
    '.json': 'application/json; charset=utf-8',
    '.jar': 'application/java-archive',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`)
        const decoded = decodeURIComponent(url.pathname)
        const requested = path.resolve(root, '.' + decoded)

        if (requested !== root && !requested.startsWith(root + path.sep)) {
            res.writeHead(403)
            res.end('Forbidden')
            return
        }

        const stat = await fs.stat(requested)
        if (!stat.isFile()) {
            res.writeHead(404)
            res.end('Not found')
            return
        }

        res.writeHead(200, {
            'Content-Type': mime[path.extname(requested).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-store'
        })
        createReadStream(requested).pipe(res)
    } catch {
        res.writeHead(404)
        res.end('Not found')
    }
})

server.listen(port, host, () => {
    console.log(`Bedragoth NeoForge TEST files: http://${host}:${port}/distribution.json`)
    console.log(`Serving: ${root}`)
    console.log('Press Ctrl+C to stop.')
})
