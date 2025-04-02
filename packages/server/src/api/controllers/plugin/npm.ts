import {
  getPluginMetadata,
  findFileRec,
  extractTarball,
  deleteFolderFileSystem,
} from "../../../utilities/fileSystem"
import fetch from "node-fetch"
import { join } from "path"
import { downloadUnzipTarball } from "./utils"

const ALLOWED_BASE_URLS = [
  "https://www.npmjs.com/package/",
  "https://registry.npmjs.org/"
];

export async function npmUpload(url: string, name: string, headers = {}) {
  let npmTarballUrl = url
  let pluginName = name

  const isValidBaseUrl = ALLOWED_BASE_URLS.some(baseUrl => npmTarballUrl.startsWith(baseUrl));
  if (!isValidBaseUrl) {
    throw new Error("The plugin origin must be from NPM")
  }

  if (!npmTarballUrl.includes(".tgz")) {
    const allowedPaths = ["/", "/-/"];
    const path = "/" + url.split("/").slice(4).join("/");
    if (!allowedPaths.some(allowedPath => path.startsWith(allowedPath))) {
      throw new Error("Invalid NPM package path");
    }
    const npmPackageURl = new URL(path, "https://registry.npmjs.org/").toString();
    const response = await fetch(npmPackageURl)
    if (response.status !== 200) {
      throw new Error("NPM Package not found")
    }

    let npmDetails = await response.json()
    pluginName = npmDetails.name
    const npmVersion = npmDetails["dist-tags"].latest
    npmTarballUrl = npmDetails?.versions?.[npmVersion]?.dist?.tarball

    if (!npmTarballUrl) {
      throw new Error("NPM tarball url not found")
    }
  }

  const path = await downloadUnzipTarball(npmTarballUrl, pluginName, headers)
  const tarballPluginFile = findFileRec(path, ".tar.gz")
  if (!tarballPluginFile) {
    throw new Error("Tarball plugin file not found")
  }

  try {
    await extractTarball(tarballPluginFile, path)
    deleteFolderFileSystem(join(path, "package"))
  } catch (err: any) {
    throw new Error(err)
  }

  return await getPluginMetadata(path)
}
