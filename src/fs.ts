import pathlib from 'path';
import fsp from 'fs/promises';

function join(path: string) {
    var safePath = pathlib.normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
    return pathlib.join(__dirname, "../data", safePath)
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

async function getAttributes(path: string) {
    try {
        const stats = await fsp.stat(join(path));
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

export const methods: Map<string, AsyncFSFunction> = new Map()

methods.set("list", async (data: any) => {
    try {
        return {
            ok: true,
            data: await fsp.readdir(join(data.path))
        }
    } catch {
        return {
            ok: false,
            err: data.path+": Not a directory"
        }
    }
})
methods.set("attributes", async (data: any) => {
    try {
        return {
            ok: true,
            data: await getAttributes(data.path)
        }
    } catch {
        return {
            ok: false,
            err: data.path+": No such file"
        }
    }
})
methods.set("exists", async (data: any) => {
    try {
        await fsp.stat(join(data.path));
        return {
            ok: true,
            data: true
        }
    } catch {
        return {
            ok: true,
            data: false
        }
    }
})
methods.set("isDir", async (data: any) => {
    const attributes = await getAttributes(data.path);
    if (attributes && attributes.isDir) {
        return {
            ok: true,
            data: true
        }
    } else {
        return {
            ok: true,
            data: false
        }
    }
})
methods.set("isReadOnly", async (data: any) => {
    const attributes = await getAttributes(data.path);
    if (attributes && attributes.isReadOnly) {
        return {
            ok: true,
            data: true
        }
    } else {
        return {
            ok: true,
            data: false
        }
    }
})
methods.set("getDrive", async () => {
    return {
        ok: true,
        data: "net"
    }
})
methods.set("getSize", async (data: any) => {
    const attributes = await getAttributes(data.path);
    if (attributes) {
        return {
            ok: true,
            data: attributes.size
        }
    } else {
        return {
            ok: false,
            err: data.path+": No such file"
        }
    }
})
methods.set("getFreeSpace", async () => {
    const stats = await fsp.statfs(join(""));
    return {
        ok: true,
        data: stats.bfree * stats.bsize
    }
})
methods.set("getCapacity", async () => {
    const stats = await fsp.statfs(join(""));
    return {
        ok: true,
        data: stats.blocks*stats.bsize
    }
})
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
                data: undefined
            }
        } catch {
            return {
                ok: false,
                err: "File exists"
            }
        }
    } else {
        return {
            ok: false,
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
                data: undefined
            }
        } catch {
            return {
                ok: false,
                err: "File exists"
            }
        }
    } else {
        return {
            ok: false,
            err: "No such file"
        }
    }
})
methods.set("delete", async (data: any) => {
    if (await getAttributes(data.path)) {
        fsp.rm(join(data.path))
        return {
            ok: true,
            data: undefined
        }
    } else {
        return {
            ok: false,
            err: "No such file"
        }
    }
})
methods.set("makeDir", async (data: any) => {
    await fsp.mkdir(join(data.path), { recursive: true });
    return {
        ok: true,
        data: undefined
    }
})
methods.set("writeFile", async (data: any) => {
    await fsp.writeFile(join(data.path), data.data)
    return {
        ok: true,
        data: undefined
    }
})
methods.set("readFile", async (data: any) => {
    const readData = await fsp.readFile(join(data.path))
    return {
        ok: true,
        data: readData.toString()
    }
})