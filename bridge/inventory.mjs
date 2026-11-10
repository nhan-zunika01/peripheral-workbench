import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const clean = value => String(value || '').toLowerCase();
export function groupDevices(hid, pnp = []) {
  const groups = new Map();
  const nodes = pnp.map(item => ({ ...item, instanceId: clean(item.instanceId), containerId: clean(item.containerId) }));
  for (const endpoint of [...nodes.map(item => ({ ...item, source: 'pnp' })), ...hid.filter(item => item.vendorId === 0x1532).map(item => ({ ...item, source: 'hid' }))]) {
    const instance = endpoint.source === 'hid' ? clean(endpoint.path).replace(/^\\\\\?\\/, '').replaceAll('#', '\\').replace(/\\\{.*$/, '') : endpoint.instanceId;
    const node = endpoint.source === 'hid' ? nodes.find(item => item.instanceId === instance) : endpoint;
    const container = node?.containerId && !/^\{?0{8}-/.test(node.containerId) ? node.containerId : '';
    const identity = container ? `container:${container}` : `endpoint:${instance}`;
    if (!groups.has(identity)) groups.set(identity, { id: createHash('sha256').update(identity).digest('hex').slice(0, 24), name: '', containerId: container || null, interfaces: [], endpoints: [] });
    const group = groups.get(identity);
    if (endpoint.source === 'hid') group.interfaces.push(endpoint);
    else group.endpoints.push(endpoint);
    const name = endpoint.product || endpoint.name;
    if (name && (!group.name || /razer/i.test(name))) group.name = name;
  }
  return [...groups.values()].map(group => {
    const supported = group.interfaces.some(item => [0xde, 0xdf].includes(item.productId) && item.interface === 0);
    return { ...group, name: group.name || 'Razer device', supported, reason: supported ? null : 'Detected by Windows; this product has no verified settings adapter. No device commands will be sent.' };
  }).sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function windowsInventory() {
  const script = String.raw`$ErrorActionPreference='Stop'; $razer=@(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_1532|VID&00021532' -or $_.FriendlyName -match 'Razer' }); $rows=@($razer | ForEach-Object { $instance=[string]$_.InstanceId; $container=(Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\'+$instance) -Name ContainerID -ErrorAction SilentlyContinue).ContainerID; if(-not $container) { $container=[string](Get-PnpDeviceProperty -InstanceId $instance -KeyName 'DEVPKEY_Device_ContainerId' -ErrorAction SilentlyContinue).Data }; [pscustomobject]@{instanceId=$instance;name=$_.FriendlyName;class=$_.Class;containerId=[string]$container} }); ConvertTo-Json -Compress -Depth 4 -InputObject $rows`;

  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(new Error('Windows device inventory failed. Check PowerShell and PnP access.')); else { try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch (error) { reject(error); } }
  }));
}
