import pathlib from 'path';
import fsp from 'fs/promises';

export class Config {
    readonly limit!: number
    readonly path!: string

    static restore(value: any) {
        if (value) {
            return new Config(value.limit, value.path)
        } else {
            return new Config()
        }
    }

    constructor(limit?: number, path?: string) {
        if (limit) this.limit = limit
        if (path) this.path = path
    }
}

export class User {
    readonly username: string;
    readonly password: string;
    readonly config: Config;
    globalConfig: Config | undefined;

    static restore (value: any) {
        if (value.username && value.password) {
            return new User(value.username, value.password, Config.restore(value.config))
        }
    }

    setGlobalConfig(config: Config) {
        this.globalConfig = config;
    }

    authenticate(username: string, password: string) {
        return username === this.username && password === this.password
    }

    getPath() {
        if (this.config.path) return this.config.path
        if (this.globalConfig?.path) return pathlib.join(this.globalConfig.path, this.username)
        return pathlib.join(process.env.MPATH || pathlib.join(__dirname, "../data"), this.username)
    }

    getLimit() {
        if (this.config.limit && this.config.limit < 0) {
            return undefined
        } else if (this.config.limit) {
            return this.config.limit
        }
        if (this.globalConfig?.limit) return this.globalConfig.limit
    }

    constructor(username: string, password: string, config?: Config) {
        this.username = username;
        this.password = password;
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
            
    }
}

export class UserList {
    private readonly users: User[];
    private readonly config: Config;

    static restore(value: any) {
        if (value.users) {
            let users: User[] = [];
            value.users.forEach((value: any) => users.push(User.restore(value)!))
            return new UserList(users, Config.restore(value.config))
        }
    }

    authenticate(auth: string | undefined) {
        if (auth) {
            const b64auth = (auth || '').split(' ')[1] || ''
            const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
            for (const user of this.users) {
                if (user.authenticate(login, password)) {
                    return user;
                }
            }
        }
    }
    
    constructor(users: User[], config?: Config) {
        this.users = users;
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
        this.users.forEach((user) => {
            user.setGlobalConfig(this.config)
        })
    }
}

export async function multi(path: string) {
    const out = UserList.restore(JSON.parse((await fsp.readFile(path)).toString()))
    if (!out) throw new Error("Malformed userlist JSON")
    return out
}

export async function single(username: string, password: string) {
    return new UserList([
        new User(username, password, new Config(undefined, process.env.MPATH || pathlib.join(__dirname, "../data")))
    ])
}