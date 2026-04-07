export class BuniteEvent<Data = unknown, Response = unknown> {
  name: string;
  data: Data;
  private _response: Response | undefined;
  responseWasSet = false;

  constructor(name: string, data: Data) {
    this.name = name;
    this.data = data;
  }

  get response(): Response | undefined {
    return this._response;
  }

  set response(value: Response) {
    this._response = value;
    this.responseWasSet = true;
  }
}
