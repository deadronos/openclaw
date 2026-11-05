/** A plugin's bound delivery lost its local authority; changing models cannot restore it. */
export class PluginDeliveryCapabilityError extends Error {
  constructor(channel?: string) {
    super(
      `plugin delivery capability is no longer active${channel ? ` (channel ${channel} is unavailable)` : ""}`,
    );
    this.name = "PluginDeliveryCapabilityError";
  }
}
