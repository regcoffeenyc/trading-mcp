# Holds the machine awake for as long as this process runs.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\keep-awake.ps1
#
# Why this exists: on a modern laptop "Sleep after: Never" is not enough. Those
# machines use Modern Standby, and the system drops into connected standby soon
# after the screen goes off — timers stop firing and the network is cut for
# ordinary processes. The bot then misses bar closes without a single error in
# its log: the socket looks fine on both sides of the gap.
#
# Observed on DESKTOP-RB4PBLE: connected standby entered roughly hourly all
# night, with the market-data feed silent for up to an hour at a time, and the
# 00:00 UTC bar close never evaluated.
#
# SetThreadExecutionState is the documented way to say "I am doing work, do not
# sleep". It needs no administrator rights, changes no saved power setting, and
# lapses the moment this process exits — close the window and the machine
# behaves exactly as it did before.
#
# The cost is real and worth stating: the display stays on, which on a laptop
# means it must stay plugged in. DISPLAY_REQUIRED is deliberate rather than
# careless — on Modern Standby, keeping the display awake is what actually keeps
# the system out of connected standby.

$ErrorActionPreference = 'Stop'

Add-Type -Name Power -Namespace KeepAwake -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS       = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED  = [uint32]'0x00000001'
$ES_DISPLAY_REQUIRED = [uint32]'0x00000002'

$result = [KeepAwake.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
if ($result -eq 0) { throw 'SetThreadExecutionState failed; the machine may still sleep.' }

Write-Host "Keeping $env:COMPUTERNAME awake. Close this window to release."

# Re-assert periodically. ES_CONTINUOUS should hold on its own, but a policy
# change or a fast-user-switch can clear it, and re-stating it costs nothing.
while ($true) {
  Start-Sleep -Seconds 60
  [void][KeepAwake.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
}
