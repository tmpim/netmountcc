import {
    CreateInfo,
    CreationDateInfo,
    DeleteInfo,
    FileSystem,
    IContextInfo,
    IListUserManager,
    ILockManager,
    IPropertyManager,
    IStorageManager,
    IStorageManagerEvaluateCallback,
    ITestableUserManager,
    IUser,
    LastModifiedDateInfo,
    LockManagerInfo,
    MoveInfo,
    OpenReadStreamInfo,
    OpenWriteStreamInfo,
    Path,
    PhysicalFileSystemResource,
    PhysicalSerializer,
    PropertyAttributes,
    PropertyManagerInfo,
    ReadDirInfo,
    RequestContext,
    ResourcePropertyValue,
    ResourceType,
    ReturnCallback,
    SimpleCallback,
    SimpleUser,
    SizeInfo,
    TypeInfo
} from "webdav-server/lib/index.v2";
import { Errors } from "webdav-server/lib/Errors";
import { Readable, Writable } from 'stream'
import { join as pathJoin } from 'path'
import { XMLElement } from 'xml-js-builder'
import { User, UserList } from "./userlist";
import * as fs from 'fs'
import { debug } from './util';

export class CustomSimpleUserManager implements ITestableUserManager, IListUserManager
{
    protected userlist: UserList

    constructor(userlist: UserList)
    {
        this.userlist = userlist
    }

    getUserByName(name : string, callback : (error : Error, user ?: User) => void)
    {
        const user = this.userlist.getUserByName(name)
        if(!user)
            callback(Errors.UserNotFound);
        else
            callback(null, user);
    }
    getDefaultUser(callback : (user : User) => void)
    {
        callback(null);
    }

    addUser(user: User) : User
    {
        this.userlist.addUserRaw(user)
        return user;
    }

    getUsers(callback : (error : Error, users : User[]) => void)
    {
        callback(null, this.userlist.users);
    }
    
    getUserByNamePassword(name : string, password : string, callback : (error : Error, user ?: User) => void) : void
    {
        this.getUserByName(name, (e, user) => {
            if(e)
                return callback(e);
            
            if(user && user.authenticate(name, password))
                callback(null, user);
            else
                callback(Errors.UserNotFound);
        })
    }
}

export class UserListStorageManager implements IStorageManager
{
    readonly userlist: UserList

    constructor(userlist: UserList)
    {
        this.userlist = userlist
    }

    reserve(ctx : RequestContext, fs : FileSystem, size : number, callback : (reserved : boolean) => void) : void
    {
        if (ctx.user instanceof User) {
            ctx.user.netfs.getCapacity().then((caps) => {
                if ( caps[0] - size < 0) {
                    callback(false);
                } else {
                    callback(true);
                }
            })
        } else {
            callback(false)
        }
    }

    evaluateCreate(ctx : RequestContext, fs : FileSystem, path : Path, type : ResourceType, callback : IStorageManagerEvaluateCallback) : void
    {
        fs.getFullPath(ctx, path, (e, fullPath) => {
            callback(fullPath!.toString().length);
        })
    }
    evaluateContent(ctx : RequestContext, fs : FileSystem, expectedSize : number, callback : IStorageManagerEvaluateCallback) : void
    {
        callback(expectedSize);
    }

    evalPropValue(value : ResourcePropertyValue) : number
    {
        if (!value)
            return 0;
        if(value.constructor === String)
            return (value as String).length;
        if(Array.isArray(value))
            return (value as XMLElement[]).map((el) => this.evalPropValue(el)).reduce((p, n) => p + n, 0);

        const xml = value as XMLElement;
        const attributesLength = Object.keys(xml.attributes).map((at) => at.length + (xml.attributes[at].length as number)).reduce((p, n) => p + n, 0);
        return xml.name.length + attributesLength + (xml.elements && xml.elements.length > 0 ? this.evalPropValue(xml.elements) : 0);
    }
    evaluateProperty(ctx : RequestContext, fs : FileSystem, name : string, value : ResourcePropertyValue, attributes : PropertyAttributes, callback : IStorageManagerEvaluateCallback) : void
    {
        callback(name.length + Object.keys(attributes).map((ak) => attributes[ak].length + ak.length).reduce((p, n) => p + n, 0) + this.evalPropValue(value));
    }

    available(ctx : RequestContext, fs : FileSystem, callback : (available : number) => void) : void
    {
        if (ctx.user instanceof User) {
            ctx.user.netfs.getCapacity().then((caps) => {
                callback(caps[0])
            })
        } else {
            callback(0)
        }
    }
    reserved(ctx : RequestContext, fs : FileSystem, callback : (reserved : number) => void) : void
    {
        if (ctx.user instanceof User) {
            ctx.user.netfs.getCapacity().then((caps) => {
                callback(caps[1] - caps[0])
            })
        } else {
            callback(0)
        }
    }
}

export class PerUserFileSystem extends FileSystem {
    resources : {
        [path : string] : PhysicalFileSystemResource
    }

    constructor(public userList : UserList)
    {
        super(new PhysicalSerializer());

        this.resources = {
            '/': new PhysicalFileSystemResource()
        };
    }

    protected getRealPath(path : Path, ctx: RequestContext)
    {
        const sPath = path.toString();
        let bPath;
        if (ctx.user.username === "_default_super_admin_") {
            bPath = "/dev/null" // Not sure why this user exists, redirect them to hell.
        } else if (!(ctx.user instanceof User)) {
            throw new Error("No Such WebDAV user " + ctx.user.username)
        } else {
            bPath = ctx.user.getPath()
        }

        return {
            realPath: pathJoin(bPath, sPath.substring(1)),
            resource: this.resources[sPath]
        };
    }

    protected _create(path : Path, ctx : CreateInfo, _callback : SimpleCallback) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);
        debug(`Webdav ${ctx.context.user.username} create ${realPath}`)

        const callback = (e: any) => {
            if(!e)
                this.resources[path.toString()] = new PhysicalFileSystemResource();
            else if(e)
                e = Errors.ResourceAlreadyExists;
            
            _callback(e);
        }

        if(ctx.type.isDirectory)
            fs.mkdir(realPath, callback);
        else
        {
            if(!fs.constants || !fs.constants.O_CREAT)
            { // node v5.* and lower
                fs.writeFile(realPath, Buffer.alloc(0), callback);
            }
            else
            { // node v6.* and higher
                fs.open(realPath, fs.constants.O_CREAT, (e, fd) => {
                    if(e)
                        return callback(e);
                    fs.close(fd, callback);
                })
            }
        }
    }

    protected _delete(path : Path, ctx : DeleteInfo, _callback : SimpleCallback) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);
        debug(`Webdav ${ctx.context.user.username} delete ${realPath}`)

        const callback = (e: any) => {
            if(!e)
                delete this.resources[path.toString()];
            _callback(e);
        }

        this.type(ctx.context, path, (e: any, type:any) => {
            if(e)
                return callback(Errors.ResourceNotFound);
            
            if(type.isDirectory)
            {
                if(ctx.depth === 0)
                    return fs.rmdir(realPath, callback);

                this.readDir(ctx.context, path, (e, files) => {
                    let nb = files!.length + 1;
                    const done = (e ?: Error) => {
                        if(nb < 0)
                            return;

                        if(e)
                        {
                            nb = -1;
                            return callback(e);
                        }
                        
                        if(--nb === 0)
                            fs.rmdir(realPath, callback);
                    }

                    files!.forEach((file) => this.delete(ctx.context, path.getChildPath(file), ctx.depth === -1 ? -1 : ctx.depth - 1, done));
                    done();
                })
            }
            else
                fs.unlink(realPath, callback);
        })
    }

    protected _openWriteStream(path : Path, ctx : OpenWriteStreamInfo, callback : ReturnCallback<Writable>) : void
    {
        const { realPath, resource } = this.getRealPath(path, ctx.context);
        debug(`Webdav ${ctx.context.user.username} write stream ${realPath}`)

        fs.open(realPath, 'w+', (e, fd) => {
            if(e)
                return callback(Errors.ResourceNotFound);
            
            if(!resource)
                this.resources[path.toString()] = new PhysicalFileSystemResource();
            
            callback(undefined, fs.createWriteStream(null! as fs.PathLike, { fd }));
        })
    }

    protected _openReadStream(path : Path, ctx : OpenReadStreamInfo, callback : ReturnCallback<Readable>) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);
        debug(`Webdav ${ctx.context.user.username} read stream ${realPath}`)

        fs.open(realPath, 'r', (e, fd) => {
            if(e)
                return callback(Errors.ResourceNotFound);
            
            callback(undefined, fs.createReadStream(null! as fs.PathLike, { fd }));
        })
    }

    protected _move(pathFrom : Path, pathTo : Path, ctx : MoveInfo, callback : ReturnCallback<boolean>) : void
    {
        const { realPath: realPathFrom } = this.getRealPath(pathFrom, ctx.context);
        const { realPath: realPathTo } = this.getRealPath(pathTo, ctx.context);

        debug(`Webdav ${ctx.context.user.username} move ${realPathFrom} -> ${realPathTo}`)

        const rename = (overwritten: boolean) => {
            fs.rename(realPathFrom, realPathTo, (e) => {
                if(e)
                    return callback(e);

                this.resources[realPathTo] = this.resources[realPathFrom];
                delete this.resources[realPathFrom];
                callback(undefined, overwritten);
            });
        };

        fs.access(realPathTo, (e) => {
            if(e)
            { // destination doesn't exist
                rename(false);
            }
            else
            { // destination exists
                if(!ctx.overwrite)
                    return callback(Errors.ResourceAlreadyExists);
                
                this.delete(ctx.context, pathTo, (e) => {
                    if(e)
                        return callback(e);
                    rename(true);
                });
            }
        })
    }

    protected _size(path : Path, ctx : SizeInfo, callback : ReturnCallback<number>) : void
    {
        this.getStatProperty(path, ctx, 'size', callback);
    }
    
    /**
     * Get a property of an existing resource (object property, not WebDAV property). If the resource doesn't exist, it is created.
     * 
     * @param path Path of the resource
     * @param ctx Context of the method
     * @param propertyName Name of the property to get from the resource
     * @param callback Callback returning the property object of the resource
     */
    protected getPropertyFromResource(path : Path, ctx : IContextInfo, propertyName : string, callback : ReturnCallback<any>) : void
    {
        let resource = this.resources[path.toString()];
        if(!resource)
        {
            resource = new PhysicalFileSystemResource();
            this.resources[path.toString()] = resource;
        }

        
        callback(undefined, resource[propertyName as keyof typeof resource]);
    }

    protected _lockManager(path : Path, ctx : LockManagerInfo, callback : ReturnCallback<ILockManager>) : void
    {
        this.getPropertyFromResource(path, ctx, 'locks', callback);
    }

    protected _propertyManager(path : Path, ctx : PropertyManagerInfo, callback : ReturnCallback<IPropertyManager>) : void
    {
        this.getPropertyFromResource(path, ctx, 'props', callback);
    }

    protected _readDir(path : Path, ctx : ReadDirInfo, callback : ReturnCallback<string[] | Path[]>) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);
        debug(`Webdav ${ctx.context.user.username} list ${realPath}`)

        fs.readdir(realPath, (e, files) => {
            callback(e ? Errors.ResourceNotFound : undefined, files);
        });
    }
    
    protected getStatProperty(path : Path, ctx : IContextInfo, propertyName : string, callback : ReturnCallback<any>) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);

        fs.stat(realPath, (e, stat) => {
            if(e)
                return callback(Errors.ResourceNotFound);
            
            callback(undefined, stat[propertyName as keyof typeof stat]);
        })
    }
    protected getStatDateProperty(path : Path, ctx : IContextInfo, propertyName : string, callback : ReturnCallback<number>) : void
    {
        this.getStatProperty(path, ctx, propertyName, (e, value) => callback(e, value ? (value as Date).valueOf() : value));
    }

    protected _creationDate(path : Path, ctx : CreationDateInfo, callback : ReturnCallback<number>) : void
    {
        this.getStatDateProperty(path, ctx, 'birthtime', callback);
    }

    protected _lastModifiedDate(path : Path, ctx : LastModifiedDateInfo, callback : ReturnCallback<number>) : void
    {
        this.getStatDateProperty(path, ctx, 'mtime', callback);
    }

    protected _type(path : Path, ctx : TypeInfo, callback : ReturnCallback<ResourceType>) : void
    {
        const { realPath } = this.getRealPath(path, ctx.context);

        fs.stat(realPath, (e, stat) => {
            if(e)
                return callback(Errors.ResourceNotFound);
            
            callback(undefined, stat.isDirectory() ? ResourceType.Directory : ResourceType.File);
        })
    }
}