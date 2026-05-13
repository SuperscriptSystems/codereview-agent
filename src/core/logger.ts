export type LogLevel = "debug" | "info" | "warn" | "error"

let traceEnabled = false

export function configureLogger(trace: boolean): void {
  traceEnabled = trace
}

function write(level: LogLevel, message: string): void {
  if (level === "debug" && !traceEnabled) {
    return
  }

  const prefix = level === "info" && !traceEnabled ? "" : `[${level}] `
  const line = `${prefix}${message}`

  if (level === "error") {
    console.error(line)
    return
  }

  if (level === "warn") {
    console.warn(line)
    return
  }

  console.log(line)
}

export const logger = {
  debug(message: string): void {
    write("debug", message)
  },
  info(message: string): void {
    write("info", message)
  },
  warn(message: string): void {
    write("warn", message)
  },
  error(message: string): void {
    write("error", message)
  },
}
