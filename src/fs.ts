import pathlib from 'path';
import chokidar from 'chokidar'
import { Stats } from 'fs'
import { RawData, WebSocket } from 'ws'
import fsp from 'fs/promises';
import { WriteFileStream, ReadFileStream, ReadObjectStream } from './stream'
import { User } from './userlist'
import { replacer, debug } from './util';
import { IncomingMessage } from 'http';
import { userlist } from "./userlist";

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

type SendFunction = (out: object)=>void
interface AsyncFSFunction {
    (data: Object, send: SendFunction, ws: WebSocket): Promise<void>;
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
    
    private connections = 0;
    private closeWatcher: (() => void) | undefined;
    private readonly netpath: string;
    private readonly methods: Map<string, AsyncFSFunction> = new Map()
    private readonly contents: Map<string, Attributes> = new Map()
    private readonly callbacks: Map<number, WatcherCallback> = new Map()

    join(path: string) {
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

    private async closestAttributes(path: string): Promise<{ attributes: Attributes | false, path: string }> {
        const dir = (/^(.*)\/.*$/).exec(path)
        if (!dir) {
            return {
                attributes: await this.getAttributes(""),
                path
            }
        } else {
            const attrs = await this.getAttributes(dir[1])
            if (attrs) {
                return {
                    attributes: attrs,
                    path
                }
            } else {
                return this.closestAttributes(dir[1])
            }
        }
    }

    private makeRelocate(type: string) {
        return async (data: any, send: SendFunction) => {
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                const path = this.join(data.path)
                if (await this.treemax(path, data.dest, attrs)) {
                    send({
                        ok: false,
                        type: type,
                        err: "Trees greater than 128 directories not allowed"
                    })
                    return
                }
                const { attributes: dattrs } = await this.closestAttributes(data.dest)
                if (dattrs && dattrs.isReadOnly) {
                    send({
                        ok: false,
                        type: type,
                        err: "Destination is read-only"
                    })
                    return
                } else if (attrs.isReadOnly && type === "move") {
                    send({
                        ok: false,
                        type: type,
                        err: "Cannot move read-only file " + data.path
                    })
                    return
                }
                try {
                    await fsp.cp(path, this.join(data.dest), {
                        recursive: true,
                        force: false,
                        errorOnExist: true
                    })
                    if (type === "move") {
                        await fsp.rm(path, {
                            recursive: true,
                            force: true
                        })
                    }
                    send({
                        ok: true,
                        type: type,
                        data: {
                            path: data.path,
                            attributes: await this.getAttributes(data.path)
                        }
                    })
                } catch {
                    send({
                        ok: false,
                        type: type,
                        err: "File exists"
                    })
                }
            } else {
                send({
                    ok: false,
                    type: type,
                    err: "No such file"
                })
                return
            }
        }
    }

    private makeMethods() {
        this.methods.set("move", this.makeRelocate("move"))
        this.methods.set("copy", this.makeRelocate("copy"))
        this.methods.set("delete", async (data: any, send: SendFunction) => {
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                if (attrs.isReadOnly) {
                    send({
                        ok: false,
                        type: "delete",
                        err: data.path + ": Access denied"
                    })
                    return
                }
                await fsp.rm(this.join(data.path), {
                    recursive: true
                })
                send({
                    ok: true,
                    type: "delete",
                    data: {
                        path: data.path,
                        attributes: false
                    }
                })
            } else {
                send({
                    ok: false,
                    type: "delete",
                    err: "No such file"
                })
                return
            }
        })
        this.methods.set("makeDir", async (data: any, send: SendFunction) => {
            const path = this.join(data.path)
            const { attributes: attrs, path: cpath } = await this.closestAttributes(data.path)
            if (attrs) {
                if (attrs.isReadOnly) {
                    send({
                        ok: false,
                        type: "makeDir",
                        err: data.path + ": Access denied"
                    })
                    return
                } else if (!attrs.isDir) {
                    if (cpath === data.path) {
                        send({
                            ok: false,
                            type: "makeDir",
                            err: data.path + ": Destination Exists"
                        })
                        return
                    } else {
                        send({
                            ok: false,
                            type: "makeDir",
                            err: data.path + ": Could not create directory"
                        })
                        return
                    }
                } else if (path.split("/").length > 128) {
                    send({
                        ok: false,
                        type: "makeDir",
                        err: "Trees greater than 128 directories not allowed"
                    })
                    return
                }
            } 
            await fsp.mkdir(path, { recursive: true });
            
            send({
                ok: true,
                type: "makeDir",
                data: {
                    path: data.path,
                    attributes: await this.getAttributes(data.path)
                }
            })
        })
        this.methods.set("writeFile", async (data: any, send: SendFunction, ws: WebSocket) => {
            if (this.join(data.path).split("/").length > 128) {
                send({
                    ok: false,
                    type: "writeFile",
                    err: "Trees greater than 128 directories from root are not allowed"
                })
                return
            }
            const attrs = await this.getAttributes(data.path)
            if (attrs) {
                if (attrs.isDir) {
                    send({
                        ok: false,
                        type: "writeFile",
                        data: "/" + data.path + ": Cannot write to directory"
                    })
                    return
                } else if (attrs.isReadOnly) {
                    send({
                        ok: false,
                        type: "writeFile",
                        data: "/" + data.path + ": Access denied"
                    })
                    return
                }
            }
            const writeStream = new WriteFileStream(data.path, data.uuid, data.chunks, ws, this)
            send({
                ok: true,
                type: "writeFile",
                data: {
                    uuid: data.uuid
                }
            })
            writeStream.run()
        })
        this.methods.set("readFile", async (data: any, send: SendFunction, ws: WebSocket) => {
            const attrs = await this.getAttributes(data.path)
            if (!attrs || (attrs && attrs.isDir)) {
                send({
                    ok: false,
                    type: "readFile",
                    err: "/" + data.path + ": No such file"
                })
                return
            }
            const readStream = new ReadFileStream(data.path, ws, this)
            await readStream.run()
            send({
                ok: true,
                type: "readFile",
                data: {
                    uuid: readStream.uuid,
                    chunks: await readStream.getChunkTotal()
                }
            })
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

    private async onReady(callback: () => void) {
        let watcher = chokidar.watch(this.join(""), {
            alwaysStat: true,
            ignorePermissionErrors: true
        }).on("all", async (name, path, stats) => {
            path = path.replace(this.join(""), "").replace(/^\//, "")
            const attributes: Attributes | false = await this.getAttributes(path, stats);
            if (attributes) {
                this.contents.set(path, attributes)
            } else {
                this.contents.delete(path)
            }
            this.callbacks.forEach((cb) => {
                cb(path, attributes)
            })
        }).on("ready", callback)
        
        return () => { 
            watcher.close()
        }
    }

    private onUpdate(callback: WatcherCallback): () => void {
        const id = this.callbacks.size
        this.callbacks.set(id, callback)
        return () => {
            this.callbacks.delete(id)
        }
    }

    async run(ws: WebSocket, req: IncomingMessage) {
        debug(`Connection established by ${this.user.username} on ${req.socket.remoteAddress} (${userlist.lookupUUID(ws)}). Connection number ${this.connections+1}`)
        const send = (data: object) => {
            const out = JSON.stringify(data, replacer)
            if (out.length < 256) {
                debug(`to ${this.user.username} on ${userlist.lookupUUID(ws)}: ${out}`)
            }
            ws.send(out)
        }

        let clearUpdateListener: () => void;
        const setup = async () => {
            // hello!
            const helloStream = new ReadObjectStream({
                contents: this.getContents(),
                capacity: await this.getCapacity()
            }, ws, this)
            await helloStream.run()
            send({
                ok: true,
                type: "hello",
                data: {
                    uuid: helloStream.uuid,
                    chunks: await helloStream.getChunkTotal()
                }
            })

            // sync relay
            clearUpdateListener = this.onUpdate(async (path: string, attributes: false | Attributes) => {
                debug("sync", path, userlist.lookupUUID(ws))
                send({
                    ok: true,
                    type: "sync",
                    data: {
                        path,
                        attributes,
                        capacity: await this.getCapacity()
                    }
                })
            })
        }

        if (this.connections == 0) {
            // Set up watcher on first connection
            this.closeWatcher = await this.onReady(setup)
        } else {
            setup()
        }

        this.connections++;

        ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (!isBinary) { // Streams are binary, we look away
                let content = JSON.parse(data.toString());
                if (content.type) {
                    const method = this.methods.get(content.type)
                    if (method) {
                        debug(`from ${this.user.username} on ${userlist.lookupUUID(ws)}: ${data}`)
                        try {
                            await method(content, send, ws)
                        } catch (e) {
                            console.error(e)
                            send({
                                ok: false,
                                type: content.type,
                                err: "An unknown error occured"
                            })
                        }
                    } else {
                        send({
                            ok: false,
                            type: content.type,
                            err: "No such request type '" + content.type + "'"
                        })
                    }
                }
            }
        })
        ws.on("close", (code, reason) => {
            debug(`Connection closed by ${this.user.username} on ${req.socket.remoteAddress} (${userlist.lookupUUID(ws)}). ${code}: ${reason || "unknown"}. Connections remaining: ${this.connections-1}`)
            this.connections--;
            if (clearUpdateListener) clearUpdateListener();
            if (this.closeWatcher && this.connections == 0) {
                // Close watcher on last disconnection
                this.contents.clear()
                this.closeWatcher()
                this.closeWatcher = undefined;
            } 
        })
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

    constructor(user: User) {
        this.user = user;
        this.netpath = this.user.getPath()
        this.makeMethods()
    }
}