// Local re-exports of the SDK's automation graph types. The flow builder
// works exclusively in terms of these (rather than importing from the SDK
// directly in every component), so we have one place to swap in alternate
// types if the SDK regenerates.
//
// The SDK exports automation types under the `Relay.*` namespace; we
// re-publish them as bare names here for ergonomics in builder code.

import type Relay from "@relayapi/sdk";

export type AutomationChannel = Relay.AutomationChannel;
export type AutomationStatus = Relay.AutomationStatus;
export type AutomationGraph = Relay.AutomationGraph;
export type AutomationNode = Relay.AutomationNode;
export type AutomationEdge = Relay.AutomationEdge;
export type AutomationPort = Relay.AutomationPort;
export type AutomationValidation = Relay.AutomationValidation;
export type AutomationResponse = Relay.AutomationResponse;
export type ApiValidationError = Relay.ValidationError;
