import type { CapabilityId, EndpointId, JsonValue } from "./common.ts";

export const FABRIC_CAPABILITY_KINDS = ["agent-competency", "tool", "resource", "control"] as const;
export type FabricCapabilityKind = (typeof FABRIC_CAPABILITY_KINDS)[number];

export interface CapabilityBinding {
  capabilityId: CapabilityId;
  kind: FabricCapabilityKind;
  endpointId: EndpointId;
  inputSchema?: Readonly<Record<string, JsonValue>>;
  contractHash: string;
  trustLevel: string;
  locality?: string;
  priority: number;
}

export interface CapabilityCandidate {
  binding: CapabilityBinding;
  reason: string;
}
