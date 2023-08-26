import pathlib from 'path';
import chokidar from 'chokidar'
import { Stats } from 'fs'
import fsp from 'fs/promises';

let netpath = pathlib.join(__dirname, "../data")

function join(path: string) {
    var safePath = pathlib.normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
    return pathlib.join(netpath, safePath)
}

export function setNetPath(path: string) {
    netpath = path
}

export interface AsyncFSFunction {
    (data: Object): Promise<Object>;
}

export class Attributes {
    readonly size: number;
    readonly isDir: boolean;
    readonly isReadOnly: boolean;
    readonly created: number;
    readonly modified: number;    

    constructor(size: number, isDir: boolean, isReadOnly: boolean, created: number, modified: number) {
        this.size = size;
        this.isDir = isDir;
        this.isReadOnly = isReadOnly;
        this.created = created;
        this.modified = modified;
    }
}

async function getAttributes(path: string, stats?: Stats) {
    try {
        if (!stats) {
            stats = await fsp.stat(join(path));
        }
        let readOnly = false;
        try {
            await fsp.access(join(path), fsp.constants.R_OK | fsp.constants.W_OK);
        } catch {
            readOnly = true;
        }
        const isDir = stats.isDirectory()
        return new Attributes(
            isDir ? 0 : stats.size,
            isDir,
            readOnly,
            Math.floor(stats.birthtimeMs),
            Math.floor(stats.mtimeMs),
        )
    } catch {
        return false
    }
}

type WatcherCallback = (path: string, attributes: Attributes | false) => void

const contents: Map<string, Attributes> = new Map()
const callbacks: Map<number, WatcherCallback> = new Map()
async function run() {
    chokidar.watch(join(""), {
        alwaysStat: true,
        ignorePermissionErrors: true
    }).on("all", async (name, path, stats) => {
        path = path.replace(join(""), "").replace(/^\//, "")
        const attributes: Attributes | false = await getAttributes(path, stats);
        // console.log(name, path, attributes)
        if (attributes) {
            contents.set(path, attributes)
        } else {
            contents.delete(path)
        }
        callbacks.forEach((callback) => {
            callback(path, attributes)
        })
    })
    
}
run()

export function getContents(): Map<string, Attributes> {
    return contents
}

export async function getCapacity(): Promise<number[]> {
    const stats = await fsp.statfs(join(""));
    return [
        stats.bfree * stats.bsize,
        stats.blocks*stats.bsize
    ]
}

export function watch(callback: WatcherCallback): () => void {
    const id = callbacks.size
    callbacks.set(id, callback)
    return () => {
        callbacks.delete(id)
    }
}

export const methods: Map<string, AsyncFSFunction> = new Map()

methods.set("move", async (data: any) => {
    if (await getAttributes(data.path)) {
        try {
            fsp.cp(join(data.path), join(data.dest), {
                recursive: true,
                force: false,
                errorOnExist: true
            })
            fsp.rm(join(data.path))
            return {
                ok: true,
                type: "move",
                data: undefined
            }
        } catch {
            return {
                ok: false,
                type: "move",
                err: "File exists"
            }
        }
    } else {
        return {
            ok: false,
            type: "move",
            err: "No such file"
        }
    }
})
methods.set("copy", async (data: any) => {
    if (await getAttributes(data.path)) {
        try {
            fsp.cp(join(data.path), join(data.dest), {
                recursive: true,
                force: false,
                errorOnExist: true
            })
            return {
                ok: true,
                type: "copy",
                data: undefined
            }
        } catch {
            return {
                ok: false,
                type: "copy",
                err: "File exists"
            }
        }
    } else {
        return {
            ok: false,
            type: "copy",
            err: "No such file"
        }
    }
})
methods.set("delete", async (data: any) => {
    if (await getAttributes(data.path)) {
        fsp.rm(join(data.path))
        return {
            ok: true,
            type: "delete",
            data: undefined
        }
    } else {
        return {
            ok: false,
            type: "delete",
            err: "No such file"
        }
    }
})
methods.set("makeDir", async (data: any) => {
    await fsp.mkdir(join(data.path), { recursive: true });
    return {
        ok: true,
        type: "makeDir",
        data: undefined
    }
})
methods.set("writeFile", async (data: any) => {
    await fsp.writeFile(join(data.path), data.data)
    return {
        ok: true,
        type: "writeFile",
        data: undefined
    }
})
methods.set("readFile", async (data: any) => {
    const readData = await fsp.readFile(join(data.path))
    return {
        ok: true,
        type: "readFile",
        data: readData.toString()
    }
})