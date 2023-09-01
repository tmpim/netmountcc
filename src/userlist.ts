import pathlib from 'path';
import fsp from 'fs/promises';
import { IUser, SimpleUserManager, SimplePathPrivilegeManager } from 'webdav-server/lib/index.v2';
import { NetFS } from './fs';

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
    readonly netfs: NetFS
    readonly davuser: IUser;
    globalConfig: Config;

    static restore (userlist: UserList, value: any) {
        if (value.username && value.password) {
            return new User(userlist, value.username, value.password, Config.restore(value.config))
        }
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

    constructor(parent: UserList, username: string, password: string, config?: Config) {
        this.username = username;
        this.password = password;
        this.globalConfig = parent.config;
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
        this.davuser = parent.usermanager.addUser(username, password, false)
        this.netfs = new NetFS(this)
        parent.privelegeManager.setRights(this.davuser, "/", ['all'])
    }
}

export class UserList {
    private readonly users: User[] = [];
    readonly usermanager: SimpleUserManager
    readonly privelegeManager: SimplePathPrivilegeManager
    config: Config;

    async fromJSON(path: string) {
        const value = JSON.parse((await fsp.readFile(path)).toString())
        if (value.users) {
            this.config = Config.restore(value.config)
            value.users.forEach((value: any) => {
                if (!this.getUserByName(value.username)) {
                    this.addUserRaw(User.restore(this, value)!)
                }
            })
            // TODO: Add user removal
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

    addUser(username: string, password: string, config?: Config): void {
        const user = new User(this, username, password, config)
        this.users.push(user)
    }

    addUserRaw(user: User): void {
        this.users.push(user)
    }

    getUserByDavuser(davuser: IUser) {
        for (let user of this.users) {
            if (user.davuser == davuser) {
                return user;
            }
        }
    }

    getUserByName(username: string) {
        for (let user of this.users) {
            if (username == user.username) {
                return user
            }
        }
    }
    
    constructor(config?: Config) {
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
        this.usermanager = new SimpleUserManager()
        this.privelegeManager = new SimplePathPrivilegeManager()
    }
}