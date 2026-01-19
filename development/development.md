> - `#` means run in your raspberry pi
> - `>` means run in your windows cmd
> - `$` means run in your windows WSL

# Imaging RaspberryPi OS
1. Use RaspberryPi OS Lite 64-bit
1. Setup hostname, user, wifi, ssh settings
1. Optionally enable RaspberryPi-Connect
1. Do NOT power RaspberryPi with laptop/PC USB ports. The power is not sufficient
1. Connect your laptop/PC to the same wifi as raspberry pi
1. SSH into raspberry pi (make sure to wait until raspberry pi is ready, get its IP from your router)
1. `# sudo apt update`
1. `# suda apt upgrade`

# Setting-up Local Ethernet Connection without a Router
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

# Setting-up Swap File over Network on RaspberryPi
1. `$ sudo apt install nbdkit socat nethogs`
1. `# sudo apt install nbd-client socat`
1. `$ chmod +x ./rpi-nbd-ram-server.sh`
1. `$ sudo ./rpi-nbd-ram-server.sh <RASPBERRY_USER>@<RASPBERRY_APIPA_ADDRESS>`. The script will attempt to SSH into raspberry pi to setup nbd-client and swapfile automatically

# Setting-up Additional Remote Disk over Network
1. `$ sudo apt install nbdkit socat nethogs`
1. `# sudo apt install nbd-client socat`
1. `$ chmod +x ./rpi-nbd-disk-server.sh`
1. `$ sudo ./rpi-nbd-disk-server.sh <RASPBERRY_USER>@<RASPBERRY_APIPA_ADDRESS> <DISK_FILE>`. The script will attempt to SSH into raspberry pi to setup nbd-client and swapfile automatically. The partition will be available under /mnt/nbd-disk

# Installing Docker in Raspberry Pi
https://docs.docker.com/engine/install/debian/
