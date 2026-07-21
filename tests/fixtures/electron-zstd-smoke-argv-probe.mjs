import { parseElectronZstdSmokeSourceDist } from "../../scripts/release/electron-zstd-smoke-command.mjs"

process.stdout.write(parseElectronZstdSmokeSourceDist(process.argv))
