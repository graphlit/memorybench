import type { Provider, ProviderName } from "../types/provider"
import { SupermemoryProvider } from "./supermemory"
import { Mem0Provider } from "./mem0"
import { ZepProvider } from "./zep"
import { GraphlitProvider } from "./graphlit"

const providers: Record<ProviderName, new () => Provider> = {
    supermemory: SupermemoryProvider,
    mem0: Mem0Provider,
    zep: ZepProvider,
    graphlit: GraphlitProvider,
}

export function createProvider(name: ProviderName): Provider {
    const ProviderClass = providers[name]
    if (!ProviderClass) {
        throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`)
    }
    return new ProviderClass()
}

export function getAvailableProviders(): ProviderName[] {
    return Object.keys(providers) as ProviderName[]
}

export { SupermemoryProvider, Mem0Provider, ZepProvider, GraphlitProvider }
