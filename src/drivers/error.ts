/** An error whose message is fit to show a person as-is. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'DriverError'
  }
}
