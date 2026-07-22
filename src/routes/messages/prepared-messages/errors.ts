export class PreparedMessagesInvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreparedMessagesInvalidRequestError"
  }
}

export class PreparedMessagesUnsupportedModelError extends Error {
  readonly model: string

  constructor(model: string) {
    super("Requested model is absent from the current Copilot model catalog")
    this.name = "PreparedMessagesUnsupportedModelError"
    this.model = model
  }
}
