import { VERSION } from "../version.js";

export const CONTROL_API_VERSION = "v1" as const;
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_SERVICE_NAME = "magi-headless";
export const MAX_CONTROL_BODY_BYTES = 16 * 1024 * 1024;

export interface ControlCapabilityDocument {
  service: typeof CONTROL_SERVICE_NAME;
  version: string;
  apiVersion: typeof CONTROL_API_VERSION;
  protocolVersion: number;
  supportedApiVersions: string[];
  features: Record<string, boolean>;
  limits: {
    maxRequestBodyBytes: number;
    maxListLimit: number;
  };
}

export function controlCapabilityDocument(): ControlCapabilityDocument {
  return {
    service: CONTROL_SERVICE_NAME,
    version: VERSION,
    apiVersion: CONTROL_API_VERSION,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    supportedApiVersions: [CONTROL_API_VERSION, "legacy"],
    features: {
      sessions: true,
      transcripts: true,
      backgroundJobs: true,
      jobCancellation: true,
      serverSentEvents: true,
      resumableEvents: true,
      approvals: true,
      userQuestions: true,
      providers: true,
      providerDiscovery: true,
      imageInputs: true,
      skills: true,
      plugins: true,
      subagents: true,
      auditLog: true
    },
    limits: {
      maxRequestBodyBytes: MAX_CONTROL_BODY_BYTES,
      maxListLimit: 500
    }
  };
}
