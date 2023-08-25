# Netmount

Websocket based file transfer system designed for ComputerCraft.

## Connecting

Netmount ships with a client program on the URL path `/mount.lua` This is the only non-password protected resource.
To use, on a CC Computer run:
```sh
> wget <url>/mount.lua <url> <username> <password>
```
or use the settings API:
```sh
> set netmount.url <url>
> set netmount.username <username>
> set netmount.password <password>
> wget <url>/mount.lua
```
where:
- `url` - the URL of the netmount server (including `http://` or `https://`!)
- `username` - the chosen netmount username 
- `password` - the chosen netmount password 
For information on setting up a username and password, see [Production Setup](#production-setup)

## Workspace Setup

To install required packages:
```sh
$ yarn
```

Run:
```sh
$ yarn run ts-node src/index.ts <username> <password>
```
The server runs on `localhost:4000`.

## Production Setup

Replace `SITENAME` with the domain name.

### Casketfile
```
# List of cloudflare IPs to unwrap to real IPs.
(cloudflare) {
    realip {
        # Force cloudflare
        # https://www.cloudflare.com/en-gb/ips/

        from 173.245.48.0/20
        from 103.21.244.0/22
        from 103.22.200.0/22
        from 103.31.4.0/22
        from 141.101.64.0/18
        from 108.162.192.0/18
        from 190.93.240.0/20
        from 188.114.96.0/20
        from 197.234.240.0/22
        from 198.41.128.0/17
        from 162.158.0.0/15
        from 104.16.0.0/13
        from 104.24.0.0/14
        from 172.64.0.0/13
        from 131.0.72.0/22

        from 2400:cb00::/32
        from 2606:4700::/32
        from 2803:f800::/32
        from 2405:b500::/32
        from 2405:8100::/32
        from 2a06:98c0::/29
        from 2c0f:f248::/32

        strict
    }
}

https://SITENAME/ {
        import cloudflare # Comment out if not using cloudflare proxying
        tls self_signed # Self-sign the TLS. If not using cloudflare proxying, remove 'self_signed'.
        log /var/log/SITENAME.access.log
        proxy / 127.0.0.1:3000 {
            transparent # allow the app on 3000 to see visitor's IPs via X-Forwarded-For header
            websocket
        }
}
```
### Systemd

1. Edit `netmountcc.service` to include your username and password on line 25.
2. Move/Copy `netmountcc.service` to `/etc/systemd/system/netmountcc.service`.
3. Either:
    a. Put Netmount's working directory in `/var/www`, with `www-data` group read & execute permissions. OR
    b. Create a symlink at `/var/www/netmount` to the working directory, with the same permissions as above.
4. Enable/Start the service:
```sh
$ systemctl enable netmountcc; systemctl start netmountcc
```
