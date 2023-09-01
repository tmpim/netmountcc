import { v4 } from 'uuid'
import fsp from 'fs/promises';
import pathlib from 'path';
import {WebSocket, RawData} from 'ws'
import { User } from './userlist';
import { NetFS } from './fs';
import { debug } from './debug';

// Safely below the max socket send limit, and divisible by 3 so base64 encoding leaves no trailing padding
const chunkSize = Math.pow(2, 16);

class Stream {
    readonly uuid: string;
    protected readonly path: string;
    protected readonly ws: WebSocket;
    protected readonly fs: NetFS;

    protected serialize(id: 0, chunk: number, data: string): string
    protected serialize(id: 1, chunk: number): string
    protected serialize(id: 2, chunk: number): string
    protected serialize(id: 3, reason: string): string
    protected serialize(id: 3): string
    protected serialize(id: 4, json: string): string
    protected serialize(id: number, ...args: any[]): string {
        let out = id.toString() + " " + this.uuid
        if (args.length == 0) {
            out += " "
        } else {
            args.forEach((str) => out += " " + str)
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

    constructor(uuid: string, path: string, ws: WebSocket, fs: NetFS) {
        this.uuid = uuid
        this.path = path;
        this.ws = ws;
        this.fs = fs;
    }
}

export class ReadStream extends Stream {

    async run() {
        const data = Buffer.from(await fsp.readFile(this.fs.join(this.path), { encoding: 'binary' }), "binary")
        const chunkTotal = Math.ceil(data.length/chunkSize)
        let total = 0;

        this.ws.send(JSON.stringify({
            ok: true,
            type: "readFile",
            data: {
                uuid: this.uuid,
                chunks: chunkTotal
            }
        }))

        const listener = (rawdata: RawData, binary: boolean) => {
            const res = this.unserialize(rawdata.toString())
            if (res && res.uuid == this.uuid && res.chunk != undefined) {
                if (res.success) {
                    total++;
                    if (total == chunkTotal) {
                        debug(`sending complete`)
                        this.ws.removeListener("message", listener)
                    }
                    return
                }
                const subchunk = data?.subarray(chunkSize * res.chunk, (chunkSize * (res.chunk + 1)))
                this.ws.send(Buffer.from(this.serialize(0, res.chunk, subchunk.toString("binary")), "binary"), {binary: true})
                debug(`sent chunk ${res.chunk}`)
            }
        }

        this.ws.on("message", listener)
    }

    constructor(path: string, ws: WebSocket, fs: NetFS) {
        super(v4(), path, ws, fs)
        this.run()
    }
}

export class WriteStream extends Stream {
    protected readonly chunkTotal: number;

    async run() {
        let chunks: Buffer[] = [];
        let total = 0;
        const listener = async (wsdata: RawData, binary: boolean) => {
            const res = this.unserialize(wsdata.toString())
            if (res && res.uuid == this.uuid && res.chunk != undefined && res.chunk >= 0 && res.chunk < this.chunkTotal && res.data != undefined) {
                debug(`got chunk ${res.chunk}`)
                chunks[res.chunk] = Buffer.from(res.data, 'binary')
                total++;
                this.ws.send(this.serialize(2, res.chunk), {binary: true})
            }
            if (total == this.chunkTotal) {
                this.ws.removeListener("message", listener)
                let size = 0;
                chunks.forEach((buf: Buffer) => size += buf.length)
                const capinfo = await this.fs.getCapacity()
                if (capinfo[0]-size <= 0) {
                    debug('out of space')
                    this.ws.send(this.serialize(3, "Out of space"))
                } else {
                    debug('saving chunks')
                    const realpath = this.fs.join(this.path)
                    await fsp.mkdir(pathlib.dirname(realpath), { recursive: true })
                    await fsp.writeFile(realpath, chunks, { encoding: 'binary' })
                    this.ws.send(this.serialize(4, JSON.stringify({
                        path: this.path,
                        attributes: await this.fs.getAttributes(realpath)
                    })))
                }
            }
        }
        this.ws.on("message", listener)
        for (let chunk = 0; chunk < this.chunkTotal; chunk++) {
            this.ws.send(this.serialize(1, chunk), {binary: true})
        }
    }

    constructor(uuid: string, path: string, chunks: number, ws: WebSocket, fs: NetFS) {
        super(uuid, path, ws, fs)
        this.chunkTotal = chunks
        this.ws.send(JSON.stringify({
            ok: true,
            type: "writeFile",
            data: {
                uuid: this.uuid
            }
        }))
        this.run()
    }
}