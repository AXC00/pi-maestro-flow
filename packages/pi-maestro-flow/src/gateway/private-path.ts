import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";

export interface GatewayWindowsAclRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type GatewayWindowsAclRunner = (request: GatewayWindowsAclRequest) => Promise<void>;

const WINDOWS_PRIVATE_PATH_SCRIPT = `$ErrorActionPreference='Stop'
$p=$env:PI_MAESTRO_PRIVATE_PATH;$k=$env:PI_MAESTRO_PRIVATE_KIND;if([string]::IsNullOrWhiteSpace($p)){throw 'path'}
$i=Get-Item -LiteralPath $p -Force;if(($k -eq 'directory') -ne [bool]$i.PSIsContainer){throw 'kind'};if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=if($k -eq 'directory'){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$inherit=if($k -eq 'directory'){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule);if($k -eq 'directory'){[IO.Directory]::SetAccessControl($p,$acl);$v=[IO.Directory]::GetAccessControl($p)}else{[IO.File]::SetAccessControl($p,$acl);$v=[IO.File]::GetAccessControl($p)}
$owner=$v.GetOwner([Security.Principal.SecurityIdentifier]);$rules=@($v.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($owner.Value -ne $sid.Value -or -not $v.AreAccessRulesProtected -or $rules.Count -ne 1){throw 'acl'}
$r=$rules[0];if($r.IdentityReference.Value -ne $sid.Value -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){throw 'acl'}`;

/** Fixed argv contains only the encoded program; private paths are environment-only. */
export const GATEWAY_WINDOWS_PRIVATE_PATH_ARGS = Object.freeze([
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
  Buffer.from(WINDOWS_PRIVATE_PATH_SCRIPT, "utf16le").toString("base64"),
]);

function defaultWindowsAclRunner(request: GatewayWindowsAclRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(request.executable, [...request.args], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: request.env,
    }, (error) => error ? reject(new Error("private Windows ACL could not be applied and verified")) : resolve());
  });
}

export async function enforceGatewayPrivatePath(
  path: string,
  kind: "directory" | "file",
  options: { platform?: NodeJS.Platform; windowsAclRunner?: GatewayWindowsAclRunner } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const runner = options.windowsAclRunner ?? defaultWindowsAclRunner;
    await runner({
      executable: "powershell.exe",
      args: GATEWAY_WINDOWS_PRIVATE_PATH_ARGS,
      env: { ...process.env, PI_MAESTRO_PRIVATE_PATH: path, PI_MAESTRO_PRIVATE_KIND: kind },
    });
    return;
  }
  await chmod(path, kind === "directory" ? 0o700 : 0o600);
  const info = await lstat(path);
  if ((kind === "directory" ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("private state permissions could not be applied and verified");
  }
}
