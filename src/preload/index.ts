import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS, type AppApi, type IpcEnvelope } from '@shared/api'

// Builds `window.api` from the channel list: "sessions:execute" becomes api.sessions.execute().
const api: Record<string, unknown> = { platform: process.platform }

for (const channel of API_CHANNELS) {
  const [group, method] = channel.split(':')
  const target = (api[group] ??= {}) as Record<string, unknown>
  target[method] = async (...args: unknown[]) => {
    const envelope: IpcEnvelope<unknown> = await ipcRenderer.invoke(channel, ...args)
    if (envelope.ok) return envelope.value
    throw new Error(envelope.error.message)
  }
}

contextBridge.exposeInMainWorld('api', api as unknown as AppApi)
