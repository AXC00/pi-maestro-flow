import {
  FabricContractError,
  assertFabricIdentifier,
  type FabricTransportProvider,
} from "pi-maestro-fabric-core/v1";

/** An explicit, host-populated registry. It never scans or resolves package names. */
export class TransportRegistry {
  readonly #providers = new Map<string, FabricTransportProvider>();

  register(provider: FabricTransportProvider): void {
    assertFabricIdentifier(provider.kind, "transport.kind");
    if (this.#providers.has(provider.kind)) {
      throw new FabricContractError("conflict", `Transport kind '${provider.kind}' is already registered`, "transport.kind");
    }
    this.#providers.set(provider.kind, provider);
  }

  unregister(kind: string): boolean {
    assertFabricIdentifier(kind, "transport.kind");
    return this.#providers.delete(kind);
  }

  find(kind: string): FabricTransportProvider | undefined {
    assertFabricIdentifier(kind, "transport.kind");
    return this.#providers.get(kind);
  }

  list(): readonly string[] {
    return [...this.#providers.keys()].sort((left, right) => left.localeCompare(right));
  }
}
