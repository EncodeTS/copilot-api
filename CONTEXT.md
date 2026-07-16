# Model Gateway

The gateway presents compatible model protocols while selecting GitHub Copilot or a configured upstream Provider for each request.

## Language

**Provider**:
A named upstream model host with its own credentials, model catalog, and protocol family.
_Avoid_: Backend, vendor

**Provider Model Alias**:
A model reference in `provider/model` form that selects both a Provider and one of its models through a standard gateway endpoint.
_Avoid_: Prefixed model, namespaced model

**Provider Type**:
The protocol family a Provider model speaks: Anthropic, OpenAI-compatible, or OpenAI Responses. A model may override its Provider's default type.
_Avoid_: Provider kind, transport type

**Copilot Model**:
A model supplied by GitHub Copilot and selected without a Provider Model Alias.
_Avoid_: Default model, built-in model
