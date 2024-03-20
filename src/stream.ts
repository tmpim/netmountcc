import { v4 } from 'uuid'
import fsp from 'fs/promises';
import pathlib from 'path';
import {WebSocket, RawData} from 'ws'
import { NetFS } from './fs';
import { replacer, debug } from './util';

const chunkSize = Math.pow(2, 16);
const options = { binary: true}

class Stream {
    readonly uuid: string;
    protected readonly ws: WebSocket;
    protected readonly fs: NetFS;
    private expire: number;
    private interval: string | number | NodeJS.Timeout;
    private inext: () => void

    protected serialize(id: 0, chunk: number, data: string): string // Send chunk data
    protected serialize(id: 1, chunk: number): string // Request this chunk (only CC uses this because of coroutine constraints)
    protected serialize(id: 2, chunk: number): string // Confirm chunk was received
    protected serialize(id: 3, reason: string): string // Send error
    protected serialize(id: 3): string // Send error (with no reason)
    protected serialize(id: 4, json: string): string // Send written file attributes
    protected serialize(id: number, ...args: any[]): string {
        let out = id.toString() + " " + this.uuid
        if (args.length == 0) {
            out += " "
        } else {
            args.forEach((str) => { out += " " + str })
        }
        return out;
    }

    protected unserialize(data: string) {
        const header = (/^([0123]) ([0-9a-fA-F-]+) /sm).exec(data)
        if (!header || header?.length < 2 || header[2] != this.uuid) {
            return undefined
        }
        let values;
        switch (header[1]) {
            case '0':
                values = (/^([0123]) ([0-9a-fA-F-]+) (\d+) (.*)$/sm).exec(data)
                if (values) {
                    return {
                        uuid: header[2],
                        chunk: Number(values[3]),
                        data: values[4]
                    }
                } else {
                    return undefined
                }
            case '1':
                values = (/(\d+)$/sm).exec(data)
                if (values) {
                    return {
                        uuid: header[2],
                        chunk: Number(values[1])
                    }
                } else {
                    return undefined
                }
            case '2':
                values = (/(\d+)$/sm).exec(data)
                if (values) {
                    return {
                        uuid: header[2],
                        chunk: Number(values[1]),
                        success: true
                    }
                } else {
                    return undefined
                }
            case '3':
                values = (/(.*)$/sm).exec(data)
                if (values) {
                    return {
                        uuid: header[2],
                        err: values[1]
                    }
                } else {
                    return undefined
                }
        }
        return undefined;
    }

    constructor(uuid: string, ws: WebSocket, fs: NetFS) {
        this.uuid = uuid;
        this.ws = ws;
        this.fs = fs;
    }

    close() {
        clearInterval(this.interval)
        if (this.inext) this.inext();
    }

    resetTimeout() {
        this.expire = Date.now() + 300000; // TODO: Increase this, and add an open stream limit.
    }

    setTimeout(next?: () => void) {
        this.inext = next;
        this.interval = setInterval(async () => {
            if (this.expire <= Date.now()) {
                clearInterval(this.interval)
                debug(`Stream ${this.uuid} timeout`)
                if (next) next();
                this.ws.send(this.serialize(3, "Stream timeout"), options)
            }
        }, 1000)
    }
}

class ReadStream extends Stream {
    protected data: Promise<string>

    async getChunkTotal() {
        return Math.ceil((await this.data).length/chunkSize)
    }

    async run(next?: () => void) {
        const data = Buffer.from(await this.data, "binary")
        const chunkTotal = await this.getChunkTotal()
        let total = 0;

        const listener = (rawdata: RawData, binary: boolean) => {
            if (binary) {
                this.resetTimeout()
                const res = this.unserialize(rawdata.toString("binary"))
                if (res && res.uuid == this.uuid && res.chunk != undefined) {
                    if (res.success) {
                        total++;
                        if (total == chunkTotal) {
                            debug(`Stream ${this.uuid} sending complete`)
                            this.close()
                            if (next) next()
                        }
                        return
                    }
                    const subchunk = data?.subarray(chunkSize * res.chunk, (chunkSize * (res.chunk + 1))).toString("binary")
                    this.ws.send(Buffer.from(this.serialize(0, res.chunk, subchunk), "binary"), options)
                    debug(`sent chunk ${res.chunk}`)
                }
            }
        }

        this.resetTimeout()
        this.ws.on("message", listener)
        super.setTimeout(() => {
            this.ws.removeListener("message", listener)
            debug(`Stream ${this.uuid} closed`)
        })
    }

    constructor(ws: WebSocket, fs: NetFS) {
        super(v4(), ws, fs)
    }
}

export class ReadFileStream extends ReadStream {
    constructor(path: string, ws: WebSocket, fs: NetFS) {
        super(ws, fs)
        this.data = fsp.readFile(this.fs.join(path), { encoding: 'binary' })
    }
}

export class ReadObjectStream extends ReadStream {
    constructor(data: object, ws: WebSocket, fs: NetFS) {
        super(ws, fs)
        const out = JSON.stringify(data, replacer)
        this.data = new Promise((resolve) => { resolve(out) })
    }
}

class WriteStream extends Stream {
    protected readonly chunkTotal: number;
    protected buffer: Buffer // Does not exist until write is complete

    async run(next?: ()=>void) {
        let chunks: Buffer[] = [];
        let total = 0;
        const listener = async (wsdata: RawData, binary: boolean) => {
            const res = this.unserialize(wsdata.toString("binary"))
            if (res && res.uuid == this.uuid && res.chunk != undefined && res.chunk >= 0 && res.chunk < this.chunkTotal && res.data != undefined) {
                debug(`Stream ${this.uuid} got chunk ${res.chunk}`)
                chunks[res.chunk] = Buffer.from(res.data, 'binary')
                total++;
                this.ws.send(this.serialize(2, res.chunk), options)
            }
            if (total == this.chunkTotal) {
                this.buffer = Buffer.concat(chunks)
                this.close()
                if (next) next()
            }
        }
        this.ws.on("message", listener)
        super.setTimeout(() => this.ws.removeListener("message", listener))
    }

    constructor( uuid: string, chunkTotal: number, ws: WebSocket, fs: NetFS) {
        super(uuid, ws, fs)
        this.chunkTotal = chunkTotal
    }
}

export class WriteFileStream extends WriteStream {
    readonly path: string;

    async run() {
        super.run(async () => {
            const capinfo = await this.fs.getCapacity()
            if (capinfo[0]-this.buffer.length <= 0) {
                debug(`Stream ${this.uuid} out of space`)
                this.ws.send(this.serialize(3, "Out of space"), options)
            } else {
                debug(`Stream ${this.uuid} saving buffer`)
                const realpath = this.fs.join(this.path)
                await fsp.mkdir(pathlib.dirname(realpath), { recursive: true })
                await fsp.writeFile(realpath, this.buffer, { encoding: 'binary' })
                this.ws.send(this.serialize(4, JSON.stringify({
                    path: this.path,
                    attributes: await this.fs.getAttributes(realpath)
                })), options)
            }
        })
    }

    constructor(path: string, uuid: string, chunkTotal: number, ws: WebSocket, fs: NetFS) {
        super(uuid, chunkTotal, ws, fs)
        this.path = path
    }
}