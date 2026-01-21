1. `git clone`
1. `pnpm i`
1. `export CLAMAT_PLATFORM=raspios-linux-arm64`
1. `export CLAMAT_TOOLCHAIN_RASPIOS_URL=https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2025-12-04/2025-12-04-raspios-trixie-arm64-lite.img.xz`
1. `export CLAMAT_TOOLCHAIN_RASPIOS_NAME=local/raspios:raspios-trixie-arm64-lite-2025-12-0`
1. `pnpm turbo run turbo:setup`
1. `pnpm turbo run turbo:build`

1. `pnpm rpi-nbd-ram-server -t pi@169.254.71.89 -r ramfs://./temp/ram-server-0 -s 2GiB`
1. `pnpm rpi-nbd-disk-server -t pi@169.254.71.89 -d /mnt/c/Users/Nadhif\ Radityo/Documents/clamat-nbd-disk.img -s 16GiB -m /mnt/nbd-disk`
1. `pnpm rpi-9p-server --target pi@169.254.71.89 --export /mnt/e/Projects/Web/clamat --mount /mnt/nbd-disk/home/devel/clamat-remote`
1. `export TARGET_REMOTE_PROJECT_PATH=/mnt/nbd-disk/home/devel/clamat-remote`
