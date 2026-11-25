import { utilityProcess, type UtilityProcess } from 'electron'
import hostModulePath from './driver-host?modulePath'
import type { HostMethod, HostMethods, HostRequest, HostResponse } from './host-protocol'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HostError'
  }
}

/** Main-process handle on the driver host. Starts it on first use, restarts it if it dies. */
export class DriverHost {
  private child: UtilityProcess | null = null
  private ready: Promise<UtilityProcess> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  async call<M extends HostMethod>(
    method: M,
    ...args: Parameters<HostMethods[M]>
  ): Promise<ReturnType<HostMethods[M]>> {
    const child = await this.start()
    const id = this.nextId++
    const request: HostRequest = { id, method, args }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject })
      child.postMessage(request)
    })
  }

  /**
   * Closes every session without ending the process, for when the window that
   * owned them is gone. A statement left running would otherwise finish on the server unseen.
   */
  closeSessions(): Promise<void> {
    // Nothing was ever opened, and asking would start the process just to tell it to stop.
    if (!this.child) return Promise.resolve()
    return this.call('closeAll').catch(() => {})
  }

  /**
   * Ends the process, after giving it up to `limit` milliseconds to stop the
   * statements its sessions are running.
   */
  async shutdown(limit = 3_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limit)
    })
    await Promise.race([this.closeSessions(), gaveUp])
    clearTimeout(timer)
    this.dispose()
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
    this.ready = null
  }

  private start(): Promise<UtilityProcess> {
    if (this.ready) return this.ready

    this.ready = new Promise((resolve) => {
      const child = utilityProcess.fork(hostModulePath, [], { serviceName: 'Database drivers' })
      this.child = child

      child.once('spawn', () => resolve(child))

      child.on('message', (response: HostResponse) => {
        const waiting = this.pending.get(response.id)
        if (!waiting) return
        this.pending.delete(response.id)
        if (response.ok) waiting.resolve(response.value)
        else waiting.reject(new HostError(response.error.message, response.error.code))
      })

      child.once('exit', () => {
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
        for (const waiting of this.pending.values()) {
          waiting.reject(new HostError('The database process stopped unexpectedly. Reconnect to continue.', 'HOST_EXIT'))
        }
        this.pending.clear()
      })
    })

    return this.ready
  }
}
