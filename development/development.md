# RaspberryPi OS

> - `#` means run in your raspberry pi
> - `>` means run in your windows cmd
> - `$` means run in your windows WSL

Developing directly on Windows is optional. What's required is a Debian-based machine, preferably with an ARM64 architecture. You can still develop from an AMD64 host, but be aware that running ARM64 Docker images in this setup will rely on emulation, which can significantly impact performance.

If you have another ARM64 machine available but still want to work from your AMD64 host, you can leverage Docker's context mechanism. In our setup, since the Raspberry Pi is already available, we use it as the ARM64 execution environment.

Developing directly on the Raspberry Pi may encounter hardware resource limitations, such as limited storage or RAM. To overcome this, we provide mechanisms to extend resources by using the host machine's disk and/or RAM (or swap) over the network via a wired Ethernet connection. This allows the Raspberry Pi to act as a lightweight ARM64 development node while utilizing the host's resources for heavier workloads.

## Imaging RaspberryPi OS
1. Use RaspberryPi OS Lite 64-bit
1. Setup hostname, user, wifi, ssh settings
1. Optionally enable RaspberryPi-Connect
1. Do NOT power RaspberryPi with laptop/PC USB ports. The power is not sufficient
1. Connect your laptop/PC to the same wifi as raspberry pi
1. SSH into raspberry pi (make sure to wait until raspberry pi is ready, get its IP from your router)
1. `# sudo apt update`
1. `# suda apt upgrade`

## Setting-up Local Ethernet Connection without a Router
> https://www.reddit.com/r/linux4noobs/comments/1hz7xe8/link_local_address_disappearing_on_raspberry_pi/
>
> On Raspberry Pi OS Bookworm, Network Manager has unexpected behaviour when dealing with an Ethernet connection that doesn't have a DHCP server available.
>
> By default Network Manager will attempt to negotiate a DHCP lease, during which time a IPv6 connection can be made (Link Local IPv6 addressing, which may explain how you are able to see one assigned)
>
> After a timeout period, if no IPv4 DHCP lease has been achieved, Network Manager will 'down' the connection, then 'up' the connection to try again.
>
> This means any connections you may have will disconnect. This will occur indefinitely.
>
> **Since we want to use IPv4 APIPA address (169.254.x.x) or IPv6 link-local address**, we want to disable this behavior.

https://forums.raspberrypi.com/viewtopic.php?p=2259581#p2259581

The current accepted work around for this issue is to create two NetworkManager Connection profiles for the same interface; a DHCP profile that has a higher priority, but fails after trying for a specific number of attempts, and a second profile, with a lower priority, that configures a link-local IP address.

```bash
# Create a NetworkManager connection file that tries DHCP first
CONNFILE1=/etc/NetworkManager/system-connections/eth0-dhcp.nmconnection
UUID1=$(uuid -v4)
sudo tee ${CONNFILE1} > /dev/null <<-EOF
[connection]
id=eth0-dhcp
uuid=${UUID1}
type=ethernet
interface-name=eth0
autoconnect-priority=100
autoconnect-retries=2
[ethernet]
[ipv4]
dhcp-timeout=3
method=auto
[ipv6]
addr-gen-mode=default
method=auto
[proxy]
EOF

# Create a NetworkManager connection file that assigns a Link-Local address if DHCP fails
CONNFILE2=/etc/NetworkManager/system-connections/eth0-ll.nmconnection
UUID2=$(uuid -v4)
sudo tee ${CONNFILE2} > /dev/null <<-EOF
[connection]
id=eth0-ll
uuid=${UUID2}
type=ethernet
interface-name=eth0
autoconnect-priority=50
[ethernet]
[ipv4]
method=link-local
[ipv6]
addr-gen-mode=default
method=auto
[proxy]
EOF

# NetworkManager will ignore nmconnection files with incorrect permissions so change them here
sudo chmod 600 ${CONNFILE1}
sudo chmod 600 ${CONNFILE2}

# Restart NetworkManager to apply changes, you will be disconnected momentarily
sudo service NetworkManager restart
```

**You need to do this every time you want to create a connection over ethernet**
1. Get the IPv4 APIPA address from your raspberry pi. `# ip a`
1. Get the IPv4 APIPA address from your windows machine. Find the value under your ethernet interface. `> ipconfig`
1. Add temporary route in your windows machine. `> route add <RASPBERRY_APIPA_ADDRESS> mask 255.255.255.255 <WINDOWS_APIPA_ADDRESS>`
1. Ensure you can ping raspberry pi using its APIPA address on the windows machine. You can also see the ethernet lights are also blinking while doing this
1. You should also be able to ping raspberry pi from WSL (since WSL default route will go to windows vEthernet switch)

## Installing Fast Reverse Protocol (FRP) on WSL
1. `$ curl -LO https://github.com/fatedier/frp/releases/download/v0.66.0/frp_0.66.0_linux_amd64.tar.gz`
1. `$ tar -zxvf frp_0.66.0_linux_amd64.tar.gz`
1. `$ sudo cp ./frp_0.66.0_linux_amd64/frps /usr/bin/`
1. `$ sudo cp ./frp_0.66.0_linux_amd64/frpc /usr/bin/`

## Installing Fast Reverse Protocol (FRP) on Raspberry Pi
1. `# curl -LO https://github.com/fatedier/frp/releases/download/v0.66.0/frp_0.66.0_linux_arm64.tar.gz`
1. `# tar -zxvf frp_0.66.0_linux_arm64.tar.gz`
1. `# sudo cp ./frp_0.66.0_linux_arm64/frps /usr/bin/`
1. `# sudo cp ./frp_0.66.0_linux_arm64/frpc /usr/bin/`

## Setting-up Swap File over Network on RaspberryPi
1. `$ sudo apt install nbdkit nethogs`
1. Ensure FRP is installed on your host machine
1. `# sudo apt install nbd-client`
1. Ensure FRP is installed on your raspberry pi
1. `$ pnpm rpi-nbd-ram-server --target <RASPBERRY_USER>@<RASPBERRY_APIPA_ADDRESS> --ram ramfs://./temp/nbd-ram-0 --size 2GiB`. The script will attempt to SSH into raspberry pi to setup nbd-client and swapfile automatically

> You may encounter problem while the script attempts to connect to FRP server. Please see [Debugging FRP QUIC Connection between WSL and Windows](#debugging-frp-quic-connection-between-wsl-and-windows)

## Setting-up Additional Remote Disk over Network on RaspberryPi
1. `$ sudo apt install nbdkit nethogs`
1. Ensure FRP is installed on your host machine
1. `# sudo apt install nbd-client`
1. Ensure FRP is installed on your raspberry pi
1. `$ pnpm rpi-nbd-disk-server --target <RASPBERRY_USER>@<RASPBERRY_APIPA_ADDRESS> --disk <DISK_FILE> --size 16GiB --mount /mnt/nbd-disk`. The script will attempt to SSH into raspberry pi to setup nbd-client and mount automatically. The partition will be available under `/mnt/nbd-disk`

> You may encounter problem while the script attempts to connect to FRP server. Please see [Debugging FRP QUIC Connection between WSL and Windows](#debugging-frp-quic-connection-between-wsl-and-windows)

## Debugging FRP QUIC Connection between WSL and Windows
A low MTU can break QUIC/KCP/UDP traffic.
- The `quic-go` implementation performs MTU discovery and may refuse to send packets if the MTU is too small.
- `kcp`, on the other hand, continues sending packets, but further analysis with Wireshark shows that these UDP packets become fragmented.
- On Windows, these fragmented UDP packets are dropped, causing the connection to fail.

In WSL, the default MTU may be as low as 1280, which is insufficient when FRP is built assuming the standard 1500 MTU.
Increase the MTU of your WSL network interface: `sudo ip link set dev eth0 mtu 1500`

## Installing Docker in Raspberry Pi
- https://docs.docker.com/engine/install/debian/
- https://docs.docker.com/engine/install/linux-postinstall/ This is important if you want to manage Docker as a non-root user.

### Move Docker to Other Disk
1. `# sudo systemctl stop docker docker.socket containerd`
1. `# sudo mkdir -p /mnt/nbd-disk/docker`
1. `# sudo nano /etc/docker/daemon.json`

   ```
    {
        "data-root": "/mnt/nbd-disk/docker"
    }
   ```

1. `# sudo rsync -axP /var/lib/docker/ /mnt/nbd-disk/docker/`
1. `# sudo mv /var/lib/docker /var/lib/docker.old`. For backup
1. `# sudo mkdir -p /mnt/nbd-disk/containerd`
1. `# sudo nano /etc/containerd/config.toml`

    ```
    root = "/mnt/nbd-disk/containerd"
    ```

1. `# sudo rsync -axP /var/lib/containerd/ /mnt/nbd-disk/containerd/`
1. `# sudo mv /var/lib/containerd /var/lib/containerd.old`. For backup
1. `# sudo systemctl daemon-reload`
1. `# sudo systemctl start docker docker.socket containerd`

> If you choose to move Docker's data to the nbd-disk, you should disable Docker from starting automatically on boot.
> This is necessary because the nbd-disk server must be started manually. If Docker tries to start before nbd-disk is available, it may fail to access its files, causing errors.
> - `# sudo systemctl disable docker.service docker.socket containerd.service`


### Controlling Raspberry Docker Context from your Host Machine
1. `# sudo systemctl stop docker docker.socket containerd`
1. `# sudo nano /etc/docker/daemon.json`

   ```
    {
        "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"]
    }
   ```

1. `# sudo sed -i 's/\ -H\ fd:\/\///g' /lib/systemd/system/docker.service`. https://stackoverflow.com/questions/44052054/unable-to-start-docker-after-configuring-hosts-in-daemon-json
1. `# sudo systemctl daemon-reload`
1. `# sudo systemctl start docker docker.socket containerd`
1. `$ docker context create raspberrypi --docker "host=tcp://<RASPBERRY_APIPA_ADDRESS>:2375"`
1. `$/> docker context use raspberrypi`

## Creating a New User with Home Directory in Another Disk
1. `# sudo mkdir -p /mnt/nbd-disk/home/devel`
1. `# sudo adduser --home /mnt/nbd-disk/home/devel devel`
1. `# sudo usermod -aG sudo devel`
1. `# sudo cp -r /etc/skel/. /mnt/nbd-disk/home/devel`
1. `# sudo chown -R devel:devel /mnt/nbd-disk/home/devel`
1. `# sudo usermod -aG docker devel`
1. `# su - devel`

## Installing NVM in Raspberry Pi
- https://github.com/nvm-sh/nvm
> The installation location will be based on the home directory `~`. Ensure you are creating a new `devel` user with home directory in `nbd-disk` to avoid running out of storage.
