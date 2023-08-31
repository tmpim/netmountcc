import pathlib from 'path';
import chokidar from 'chokidar'
import { Stats } from 'fs'
import fsp from 'fs/promises';
import { v4 } from 'uuid';
import { WriteStream, ReadStream } from './stream'
import { WebSocket, RawData } from 'ws'
import { User} from './userlist'

function debug(message?: any, ...optionalParams: any[]) {
    if (process.env.DEBUG) {
        console.log(message, ...optionalParams)
    }
}

const dirSize = async (dir: string): Promise<number> => {
    try {
        const files = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
        const paths = files.map( async file => {
            const path = pathlib.join(file.path, file.name);
            if (file.isFile()) {
                try {
                    const { size } = await fsp.stat(path);
                    return size;
                } catch (e) {
                    return 0;
                }
            }
          return 0;
        } );
        return ( await Promise.all( paths ) ).reduce( ( i, size ) => i + size, 0 );
    } catch {
        return 0;
    }
}

export interface AsyncFSFunction {
    (data: Object): Promise<Object | undefined>;
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

type WatcherCallback = (path: string, attributes: Attributes | false) => void

export class NetFS {
    readonly user: User;
    readonly ws: WebSocket;
    readonly methods: Map<string, AsyncFSFunction> = new Map()

    private readonly netpath: string;
    private readonly contents: Map<string, Attributes> = new Map()
    private readonly callbacks: Map<number, WatcherCallback> = new Map()

    private join(path: string) {
        var safePath = pathlib.normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
        return pathlib.join(this.netpath, safePath)
    }

    private async treemax(path: string, dest: string, attrs: Attributes) {
        if (attrs.isDir) {
            for (const file of await fsp.readdir(path, {recursive: true})) {
                if (pathlib.join(dest, file).split("/").length > 128) {
                    return true
                }
            }
        }
        return false
    }

    private makeMethods() {
        this.methods.set("move", async (data: any) => {
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                const path = this.join(data.path)
                if (await this.treemax(path, data.dest, attrs)) {
                    return {
                        ok: false,
                        type: "move",
                        err: "Trees greater than 128 directories not allowed"
                    }
                }
                try {
                    await fsp.cp(path, this.join(data.dest), {
                        recursive: true,
                        force: false,
                        errorOnExist: true
                    })
                    await fsp.rm(path)
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
        this.methods.set("copy", async (data: any) => {
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                try {
                    if (await this.treemax(data.path, data.dest, attrs)) {
                        return {
                            ok: false,
                            type: "copy",
                            err: "Trees greater than 128 directories not allowed"
                        }
                    }
                    await fsp.cp(this.join(data.path), this.join(data.dest), {
                        recursive: true,
                        force: false,
                        errorOnExist: true
                    })
                    return {
                        ok: true,
                        type: "copy",
                        data: undefined
                    }
                } catch (e) {
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
        this.methods.set("delete", async (data: any) => {
            if (await this.getAttributes(data.path)) {
                await fsp.rm(this.join(data.path), {
                    recursive: true
                })
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
        this.methods.set("makeDir", async (data: any) => {
            if (this.join(data.path).split("/").length > 128) {
                return {
                    ok: false,
                    type: "makeDir",
                    err: "Trees greater than 128 directories not allowed"
                }
            }
            await fsp.mkdir(this.join(data.path), { recursive: true });
            return {
                ok: true,
                type: "makeDir",
                data: undefined
            }
        })
        this.methods.set("writeFile", async (data: any) => {
            if (this.join(data.path).split("/").length > 128) {
                return {
                    ok: false,
                    type: "writeFile",
                    err: "Trees greater than 128 directories not allowed"
                }
            }
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                if (attrs.isDir) {
                    return {
                        ok: false,
                        type: "writeFile",
                        data: "/" + data.path + ": Cannot write to directory"
                    }
                } else if (attrs.isReadOnly) {
                    return {
                        ok: false,
                        type: "writeFile",
                        data: "/" + data.path + ": Access denied"
                    }
                }
            }
            new WriteStream(data.uuid, this.join(data.path), data.chunks, this)
            return undefined;
            
        })
        this.methods.set("readFile", async (data: any) => {
            const attrs = await this.getAttributes(data.path)
            if (!attrs || (attrs && attrs.isDir)) {
                return {
                    ok: false,
                    type: "readFile",
                    err: "/" + data.path + ": No such file"
                }
            }
            new ReadStream(this.join(data.path), this)
            return undefined;
        })
    }

    async getAttributes(path: string, stats?: Stats) {
        try {
            if (!stats) {
                stats = await fsp.stat(this.join(path));
            }
            let readOnly = false;
            try {
                await fsp.access(this.join(path), fsp.constants.R_OK | fsp.constants.W_OK);
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

    async run(callback: () => void) {
        // Create the directory if it doesn't exist already
        await fsp.mkdir(this.join(""), { recursive: true });
        chokidar.watch(this.join(""), {
            alwaysStat: true,
            ignorePermissionErrors: true
        }).on("all", async (name, path, stats) => {
            path = path.replace(this.join(""), "").replace(/^\//, "")
            const attributes: Attributes | false = await this.getAttributes(path, stats);
            // console.log(name, path, attributes)
            if (attributes) {
                this.contents.set(path, attributes)
            } else {
                this.contents.delete(path)
            }
            this.callbacks.forEach((callback) => {
                callback(path, attributes)
            })
        }).on("ready", callback)
        
    }

    getContents(): Map<string, Attributes> {
        return this.contents
    }

    async getCapacity(): Promise<number[]> {
        const stats = await fsp.statfs(this.join(""));
        let size = stats.blocks * stats.bsize
        let free = stats.bfree * stats.bsize
        const limit = this.user.getLimit()
        if (limit) {
            
            size = limit
            free = size - (await dirSize(this.netpath))
        }
        return [free, size]
    }

    watch(callback: WatcherCallback): () => void {
        const id = this.callbacks.size
        this.callbacks.set(id, callback)
        return () => {
            this.callbacks.delete(id)
        }
    }

    constructor(user: User, ws: WebSocket) {
        this.user = user;
        this.ws = ws;
        this.netpath = this.user.getPath()
        this.makeMethods()
    }
}