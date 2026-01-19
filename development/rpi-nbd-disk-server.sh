#!/usr/bin/env bash
set -euo pipefail

# ---------- Args ----------
if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <RASPBERRY_DESTINATION> <DISK_FILE>"
    exit 1
fi

RASPBERRY_DESTINATION="$1"
DISK_FILE="$2"

# ---------- Config ----------
DISK_SIZE="4G"
IFACE="eth0"
PORT="10807"
REVERSE_PORT="10806"
SSH_CONTROL_SOCK="/tmp/rpi-nbd-disk-server-ssh-control.sock"

NBDKIT_PID=""
SSH_PID=""
SOCAT_PID=""
MON_PID=""

cleanup() {
    echo
    echo "[*] Cleaning up..."

    [[ -n "$MON_PID" ]] && kill "$MON_PID" 2>/dev/null || true
    [[ -n "$SOCAT_PID" ]] && kill "$SOCAT_PID" 2>/dev/null || true
    [[ -f "$SSH_CONTROL_SOCK" ]] && ssh -O exit -o ControlPath="$SSH_CONTROL_SOCK" "$RASPBERRY_DESTINATION" 2>/dev/null || true
    [[ -n "$SSH_PID" ]] && kill "$SSH_PID" 2>/dev/null || true
    [[ -f "$SSH_CONTROL_SOCK" ]] && rm -f "$SSH_CONTROL_SOCK"
    [[ -n "$NBDKIT_PID" ]] && kill "$NBDKIT_PID" 2>/dev/null || true

    echo "[*] Done."
}

trap cleanup INT TERM EXIT

if [[ ! -f "$DISK_FILE" ]]; then
    echo "[*] Disk file $DISK_FILE does not exist. Creating $DISK_SIZE disk with one partition..."
    fallocate -l "$DISK_SIZE" "$DISK_FILE"

    parted "$DISK_FILE" --script mklabel msdos
    parted "$DISK_FILE" --script mkpart primary ext4 1MiB 100%

    LOOP=$(sudo losetup --show -fP "$DISK_FILE")
    echo "[*] Loop device: $LOOP"

    sudo mkfs.ext4 -F "${LOOP}p1"
    sudo losetup -d "$LOOP"
    echo "[*] Disk $DISK_FILE prepared."
else
    echo "[*] Using existing disk file $DISK_FILE"
fi

echo "[*] Starting nbdkit..."
nbdkit --foreground --ip-addr "127.0.0.1" --port "$PORT" file "$DISK_FILE" --filter=truncate &
NBDKIT_PID=$!
echo "[*] nbdkit PID: $NBDKIT_PID"

echo "[*] Starting reverse TCP tunnel A in $RASPBERRY_DESTINATION"
ssh -f -o ControlMaster=yes -o ControlPath="$SSH_CONTROL_SOCK" "$RASPBERRY_DESTINATION" \
    "socat \"TCP-LISTEN:$REVERSE_PORT\" \"TCP-LISTEN:$PORT,bind=127.0.0.1\""
SSH_PID=$(ssh -O check -o ControlPath="$SSH_CONTROL_SOCK" "$RASPBERRY_DESTINATION" 2>&1 \
          | awk '/pid=/ { gsub(/[^0-9]/,"",$NF); print $NF }')
echo "[*] SSH PID: $SSH_PID"

sleep 1

echo "[*] Starting reverse TCP tunnel B"
RASPBERRY_IP=$(awk '{s=$0; sub(/^[^@]+@/,"",s); if(s~/^\[/){sub(/^\[/,"",s); sub(/\].*/,"",s)} else sub(/:.*/,"",s); print s}' <<< "$RASPBERRY_DESTINATION")
socat "TCP:$RASPBERRY_IP:$REVERSE_PORT" "TCP:127.0.0.1:$PORT" &
SOCAT_PID=$!
echo "[*] socat PID: $SOCAT_PID"

echo "[*] Mounting swap file"
ssh "$RASPBERRY_DESTINATION" "sudo nbd-client 127.0.0.1 "$PORT" /dev/nbd1 && sudo partprobe /dev/nbd1 && sudo mkdir -p /mnt/nbd-disk && sudo mount /dev/nbd1p1 /mnt/nbd-disk"

# ---------- Bandwidth monitor ----------
echo "[*] Monitoring tunnel bandwidth (Ctrl+C to stop)"
nethogs -t -d 1 "$IFACE" 2>/dev/null | \
awk -v pid="$SOCAT_PID" '
BEGIN {
    max_tx = 1
    max_rx = 1
}
/^[^\/]+\/[0-9]+\/[0-9]+/ {
    split($1, a, "/")
    if (a[1] == "socat" && a[2] == pid) {
        tx = $2
        rx = $3
        if (max_tx < tx) max_tx = tx
        if (max_rx < rx) max_rx = rx
        bars_tx = int((tx / max_tx) * 15)
        bars_rx = int((rx / max_rx) * 15)

        printf "\rTunnel: "
        printf "TX %7.2f KB/s [", tx
        for (i = 0; i < bars_tx; i++) printf "#"
        for (i = bars_tx; i < 15; i++) printf " "
        printf "]  "
        printf "RX %7.2f KB/s [", rx
        for (i = 0; i < bars_rx; i++) printf "#"
        for (i = bars_rx; i < 15; i++) printf " "
        printf "]"
        fflush()
    }
}' &
MON_PID=$!
echo "[*] Monitoring PID: $MON_PID"

wait "$NBDKIT_PID"
