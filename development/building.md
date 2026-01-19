1. `git clone`
1. `pnpm i`
1. `export CLAMAT_PLATFORM=raspios-linux-arm64`
1. `export CLAMAT_TOOLCHAIN_RASPIOS_URL=https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2025-12-04/2025-12-04-raspios-trixie-arm64-lite.img.xz`
1. `export CLAMAT_TOOLCHAIN_RASPIOS_NAME=local/raspios:raspios-trixie-arm64-lite-2025-12-0`
1. `pnpm turbo run turbo:setup`
1. `pnpm turbo run turbo:build`
