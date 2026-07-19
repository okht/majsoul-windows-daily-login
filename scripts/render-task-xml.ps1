param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Primary", "Catchup")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,

  [Parameter(Mandatory = $true)]
  [string]$UserId
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LauncherPath)) {
  throw "LauncherPath is required."
}
if ([string]::IsNullOrWhiteSpace($UserId)) {
  throw "UserId is required."
}

$esc = [System.Security.SecurityElement]
$user = $esc::Escape($UserId)
$command = $esc::Escape($LauncherPath)
$argument = if ($Mode -eq "Primary") { "primary" } else { "catchup" }

# Scheduler XML may only carry primary|catchup. Never embed acceptance CLIs.
if ($argument -notin @("primary", "catchup")) {
  throw "Invalid scheduler argument."
}

$triggers = if ($Mode -eq "Primary") {
  @"
    <CalendarTrigger>
      <StartBoundary>2026-01-01T10:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <RandomDelay>PT2H30M</RandomDelay>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"@
} else {
  @"
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <StateChange>SessionUnlock</StateChange>
    </SessionStateChangeTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T12:30:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT15M</Interval>
        <Duration>PT11H15M</Duration>
        <StopAtDurationEnd>true</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"@
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MajSoulDaily $Mode schedule (windowless installed launcher)</Description>
  </RegistrationInfo>
  <Triggers>
$triggers
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>8</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$command</Command>
      <Arguments>$argument</Arguments>
    </Exec>
  </Actions>
</Task>
"@

Write-Output $xml
