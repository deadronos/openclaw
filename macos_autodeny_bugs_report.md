# macOS Companion App Auto-Deny Bugs Report

This report outlines several critical bugs and logic flaws in the macOS companion app's execution approval system, specifically focusing on how the app incorrectly auto-denies legitimate approval requests.

The core issue stems from `ExecApprovalsGatewayPrompter.swift`, where the app's logic for deciding *whether to show a local UI prompt* is incorrectly coupled with *actively resolving the Gateway approval*. When the macOS app decides it shouldn't show a prompt, it actively sends a fallback decision (usually `.deny`) to the Gateway, sabotaging valid requests.

## 1. Active Sabotage of Remote Clients (Gateway Race Condition)
**Location:** `ExecApprovalsGatewayPrompter.handle(push:)`

When the Gateway broadcasts an `exec.approval.requested` event, it goes to all connected clients. The macOS app receives it and evaluates `shouldPresent`. If `presentation.canPresent` is `false`, the macOS app executes `fallbackDecision` (which defaults to `.deny` for secure setups) and actively sends an `execApprovalResolve` payload back to the Gateway:

```swift
guard presentation.canPresent else {
    let decision = Self.fallbackDecision(...)
    try await GatewayConnection.shared.requestVoid(
        method: .execApprovalResolve,
        params: ["id": AnyCodable(request.id), "decision": AnyCodable(decision.rawValue)],
        ...)
    return
}
```

**Impact:** If a user initiates an action from another device (e.g., a mobile app, Slack, or Discord) and the macOS app happens to be running but decides it shouldn't prompt locally, the macOS app will instantly race and reject the request for the entire system before the user can approve it on their other device.

## 2. The "Idle Mac" Auto-Deny (120-Second Rule)
**Location:** `ExecApprovalsGatewayPrompter.shouldPresent(...)`

The app checks the physical inactivity of the Mac using `CGEventSource.secondsSinceLastEventType`. If the Mac hasn't received mouse or keyboard input in the last 120 seconds, the `recentlyActive` flag is set to `false`.

```swift
let recentlyActive = lastInputSeconds.map { $0 <= thresholdSeconds } ?? (mode == .local)

if let session = requested, !session.isEmpty {
    if let active, !active.isEmpty {
        return active == session
    }
    return recentlyActive // Evaluates to false if idle > 120s
}
```

**Impact:** If a user steps away from their Mac for more than 2 minutes and attempts to use the assistant remotely, any approval request sent with a session ID will trigger `canPresent == false`. The sleeping macOS app will instantly auto-deny the remote request.

## 3. Session Mismatch Auto-Deny
**Location:** `ExecApprovalsGatewayPrompter.shouldPresent(...)`

If the Mac app currently has an active WebChat session (`activeSession`), and an approval request arrives for a different session (`requestSession`), the presentation logic requires an exact match:

```swift
if let session = requested, !session.isEmpty {
    if let active, !active.isEmpty {
        return active == session // Auto-denies if sessions don't match
    }
    // ...
}
```

**Impact:** If the user is looking at Chat Session A on their Mac, and a background task or a remote request triggers an approval for Chat Session B, the Mac app will evaluate this as `false`. Instead of queuing the prompt or ignoring it, the app immediately resolves Session B's request with a `.deny`, breaking background workflows and multi-session usage.

## 4. Remote Mode Sessionless Auto-Deny
**Location:** `ExecApprovalsGatewayPrompter.shouldPresent(...)`

If the macOS app is running in `.remote` mode and receives a request without a specific session ID, while there is no local active session, the logic falls through to the bottom of the function:

```swift
if let active, !active.isEmpty {
    return true
}
return mode == .local // Returns false for .remote
```

**Impact:** In remote mode, all sessionless execution requests will result in `shouldPresent` returning `false`. Because of the active sabotage bug (Bug #1), this results in an immediate `.deny` broadcast to the Gateway.

## 5. Ask Policy Bypass Forcing Auto-Denial
**Location:** `ExecApprovalsGatewayPrompter.handle(push:)`

If the `ask` policy determines that a prompt shouldn't be shown (e.g., `ask == .off`), the app instantly resolves the Gateway request locally:

```swift
guard presentation.shouldAsk else {
    let decision: ExecApprovalDecision = presentation.security == .full ? .allowOnce : .deny
    try await GatewayConnection.shared.requestVoid(...)
    return
}
```

**Impact:** Similar to the UI presentation failure, if the macOS app is configured not to prompt (e.g., `ask == .off` with `security == .allowlist`), it immediately kills the approval request with `.deny` for anything not explicitly falling back to allow. It shouldn't unilaterally resolve Gateway-wide approvals if it isn't the primary executor or if other clients might have different presentation capabilities.

## Summary & Recommendations
The macOS companion app conflates **"I cannot/should not show a UI prompt"** with **"I must reject this execution."**
To fix these issues, the macOS app should:
1. Simply ignore (return out of the handler) `exec.approval.requested` events that it cannot present, leaving the Gateway or other clients to handle them or let them time out.
2. Only send `.deny` or `.allowOnce` when the user *explicitly* interacts with a local prompt, or if an explicit local `allowlist`/auto-allow policy definitively matches the command.
