import jestOpenAPI from "jest-openapi"
import { spec } from "../../../../specs/generate"
import TestConfiguration from "../TestConfiguration"
import request, { SuperTest, Test, Response } from "supertest"
import { ReadStream } from "fs"
import { getServer } from "../../../app"

jestOpenAPI(spec() as any)

type Headers = Record<string, string | string[] | undefined>
type Method = "get" | "post" | "put" | "patch" | "delete"

export interface AttachedFile {
  name: string
  file: Buffer | ReadStream | string
}

function isAttachedFile(file: any): file is AttachedFile {
  if (file === undefined) {
    return false
  }
  const attachedFile = file as AttachedFile
  return (
    Object.hasOwnProperty.call(attachedFile, "file") &&
    Object.hasOwnProperty.call(attachedFile, "name")
  )
}

export interface Expectations {
  status?: number
  headers?: Record<string, string | RegExp>
  headersNotPresent?: string[]
  body?: Record<string, any>
}

export interface RequestOpts {
  headers?: Headers
  query?: Record<string, string | undefined>
  body?: Record<string, any>
  fields?: Record<string, any>
  files?: Record<
    string,
    Buffer | ReadStream | string | AttachedFile | undefined
  >
  expectations?: Expectations
  publicUser?: boolean
  useProdApp?: boolean
}

export abstract class TestAPI {
  config: TestConfiguration
  request: SuperTest<Test>
  prefix = ""

  constructor(config: TestConfiguration) {
    this.config = config
    this.request = config.request!
  }

  protected _get = async <T>(url: string, opts?: RequestOpts): Promise<T> => {
    return await this._request<T>("get", `${this.prefix}${url}`, opts)
  }

  protected _post = async <T>(url: string, opts?: RequestOpts): Promise<T> => {
    return await this._request<T>("post", `${this.prefix}${url}`, opts)
  }

  protected _put = async <T>(url: string, opts?: RequestOpts): Promise<T> => {
    return await this._request<T>("put", `${this.prefix}${url}`, opts)
  }

  protected _patch = async <T>(url: string, opts?: RequestOpts): Promise<T> => {
    return await this._request<T>("patch", `${this.prefix}${url}`, opts)
  }

  protected _delete = async <T>(
    url: string,
    opts?: RequestOpts
  ): Promise<T> => {
    return await this._request<T>("delete", `${this.prefix}${url}`, opts)
  }

  protected _requestRaw = async (
    method: "get" | "post" | "put" | "patch" | "delete",
    url: string,
    opts?: RequestOpts,
    attempt = 0
  ): Promise<Response> => {
    const {
      headers = {},
      query = {},
      body,
      fields = {},
      files = {},
      expectations,
    } = opts || {}
    const { status = 200 } = expectations || {}
    const expectHeaders = expectations?.headers || {}

    if (status !== 204 && !expectHeaders["Content-Type"]) {
      expectHeaders["Content-Type"] = /^application\/json/
    }

    let queryParams: string[] = []
    for (const [key, value] of Object.entries(query)) {
      if (value) {
        queryParams.push(`${key}=${value}`)
      }
    }
    if (queryParams.length) {
      url += `?${queryParams.join("&")}`
    }

    const app = getServer()
    let req = request(app)[method](url)
    req = req.set(
      await this.getHeaders(opts, {
        "x-budibase-include-stacktrace": "true",
      })
    )
    if (headers) {
      req = req.set(headers)
    }
    if (body) {
      req = req.send(body)
    }
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value)
    }

    for (const [key, value] of Object.entries(files)) {
      if (isAttachedFile(value)) {
        req = req.attach(key, value.file, value.name)
      } else {
        req = req.attach(key, value as any)
      }
    }
    if (expectations?.headers) {
      for (const [key, value] of Object.entries(expectations.headers)) {
        if (value === undefined) {
          throw new Error(
            `Got an undefined expected value for header "${key}", if you want to check for the absence of a header, use headersNotPresent`
          )
        }
        req = req.expect(key, value as any)
      }
    }

    let resp: Response | undefined = undefined
    try {
      resp = await req
    } catch (e: any) {
      // We've found that occasionally the connection between supertest and the
      // server supertest starts gets reset. Not sure why, but retrying it
      // appears to work. I don't particularly like this, but it's better than
      // flakiness.
      if (e.code === "ECONNRESET") {
        if (attempt > 2) {
          throw e
        }
        return await this._requestRaw(method, url, opts, attempt + 1)
      }
      throw e
    }
    return resp
  }

  protected async getHeaders(
    opts?: RequestOpts,
    extras?: Record<string, string | string[]>
  ): Promise<Record<string, string | string[]>> {
    if (opts?.publicUser) {
      return this.config.publicHeaders({ prodApp: opts?.useProdApp, extras })
    } else {
      return this.config.defaultHeaders(extras, opts?.useProdApp)
    }
  }

  protected _checkResponse(response: Response, expectations?: Expectations) {
    const { status = 200 } = expectations || {}

    if (response.status !== status) {
      let message = `Expected status ${status} but got ${response.status}`

      const stack = response.body.stack
      delete response.body.stack

      if (response.body) {
        message += `\n\nBody:`
        const body = JSON.stringify(response.body, null, 2)
        for (const line of body.split("\n")) {
          message += `\n⏐ ${line}`
        }
      }

      if (stack) {
        message += `\n\nStack from request handler:`
        for (const line of stack.split("\n")) {
          message += `\n⏐ ${line}`
        }
      }

      if (response.error) {
        // Sometimes the error can be between supertest and the app, and when
        // that happens response.error is sometimes populated with `text` that
        // gives more detail about the error. The `message` is almost always
        // useless from what I've seen.
        if (response.error.text) {
          response.error.message = response.error.text
        }
        throw new Error(message, { cause: response.error })
      } else {
        throw new Error(message)
      }
    }

    if (expectations?.headersNotPresent) {
      for (const header of expectations.headersNotPresent) {
        if (response.headers[header]) {
          throw new Error(
            `Expected header ${header} not to be present, found value "${response.headers[header]}"`
          )
        }
      }
    }

    if (expectations?.body) {
      expect(response.body).toMatchObject(expectations.body)
    }

    return response
  }

  protected _request = async <T>(
    method: Method,
    url: string,
    opts?: RequestOpts
  ): Promise<T> => {
    return this._checkResponse(
      await this._requestRaw(method, url, opts),
      opts?.expectations
    ).body
  }
}

export abstract class PublicAPI extends TestAPI {
  prefix = "/api/public/v1"

  protected async getHeaders(
    opts?: RequestOpts,
    extras?: Record<string, string | string[]>
  ): Promise<Record<string, string | string[]>> {
    const apiKey = await this.config.generateApiKey()

    const headers: Record<string, string | string[]> = {
      Accept: "application/json",
      Host: this.config.tenantHost(),
      "x-budibase-api-key": apiKey,
      "x-budibase-app-id": this.config.getAppId(),
      ...extras,
    }

    return headers
  }

  protected _checkResponse(response: Response, expectations?: Expectations) {
    const checked = super._checkResponse(response, expectations)
    if (checked.status >= 200 && checked.status < 300) {
      // We don't seem to have documented our errors yet, so for the time being
      // we'll only do the schema check for successful responses.
      expect(checked).toSatisfyApiSpec()
    }
    return checked
  }
}
