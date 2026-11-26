' Roku interpreter desktop test. The hardware objects below are associative-array fakes.
Sub Main()
    m.systemLog = invalid
    m.playerId = "A"
    m.failures = 0

    config = ParseJson("{""schema_version"":1,""group_id"":""bench"",""ptp_domain"":15,""apply_ptp_settings"":false,""enable_genlock"":false,""loop_mode"":""seamless"",""leader_id"":""A"",""players"":{""192.168.1.11"":""A"",""192.168.1.12"":""B""}}")
    Check(ValidConfig(config), "valid configuration")
    originalPlayers = config.players
    config.players = {"192.168.1.11": "A"}
    Check(not ValidConfig(config), "a one-player group is rejected")
    config.players = originalPlayers
    config.players["192.168.1.13"] = "A"
    Check(not ValidConfig(config), "duplicate player ID")
    config.players["192.168.1.13"] = "../C"
    Check(not ValidConfig(config), "unsafe player ID")
    config.players["192.168.1.13"] = "C"
    config.ptp_domain = 128
    Check(not ValidConfig(config), "invalid PTP domain")
    config.ptp_domain = 15
    config.leader_id = "D"
    Check(not ValidConfig(config), "unknown leader")
    config.leader_id = "C"
    Check(ValidConfig(config), "alternative leader")
    config.output_mode = "3840x2160x50p"
    Check(not ValidConfig(config), "card output requires card identity")
    config.card_player_id = "B"
    Check(ValidConfig(config), "4K presentation card")
    config.output_mode = "1920x1080x50p"
    Check(ValidConfig(config), "HD presentation card")
    config.card_player_id = "../B"
    Check(not ValidConfig(config), "unsafe card identity")
    config.card_player_id = "D"
    Check(not ValidConfig(config), "card identity outside group")
    config.card_player_id = "B"
    config.output_mode = "auto"
    Check(not ValidConfig(config), "automatic mode is unavailable for synced cards")

    config.output_mode = "3840x2160x50p"
    profile = {address: "192.168.1.12", netmask: "255.255.255.0", broadcast: "192.168.1.255"}
    schedule = {timezone: "Australia/Sydney", on: "07:00", off: "21:00"}
    config.static_ipv4 = profile
    config.display_schedule = schedule
    config.loop_mode = "reschedule"
    Check(ValidConfig(config), "static IP and daily Sydney schedule")
    Check(ValidStaticIPv4(profile, config.players, config.card_player_id), "static profile accepted for its card")
    Check(TrimCardPassword("Example7-setup" + Chr(13) + Chr(10)) = "Example7-setup", "trim only password line ending")
    Check(ValidCardPassword("Example7-setup"), "DWS accepts a suitable operator password")
    Check(not ValidCardPassword("") And not ValidCardPassword("short7!") And not ValidCardPassword("Example7"), "no empty or insufficient DWS password")
    profile.address = "192.168.1.11"
    Check(not ValidStaticIPv4(profile, config.players, config.card_player_id), "card cannot claim another player's IP")
    profile.address = "192.168.1.12"
    profile.broadcast = "192.168.2.255"
    Check(not ValidStaticIPv4(profile, config.players, config.card_player_id), "wrong broadcast rejected")
    profile.broadcast = "192.168.1.255"
    schedule.off = "25:00"
    Check(not ValidConfig(config), "invalid stop time rejected")
    schedule.off = "21:00"
    Check(not MatchesStaticIPv4({dhcp: true, ip4_address: profile.address, ip4_netmask: profile.netmask}, profile), "DHCP address is not provisioned")
    Check(MatchesStaticIPv4({dhcp: false, ip4_address: profile.address, ip4_netmask: profile.netmask}, profile), "confirmed static address")

    network = {
        SetIP4Address: FakeSetIP
        SetIP4Netmask: FakeSetMask
        SetIP4Broadcast: FakeSetBroadcast
        Apply: FakeApply
        sequence: ""
        rejectMask: false
    }
    Check(ApplyStaticIPv4(network, profile), "static network staged and applied")
    Check(network.sequence = "192.168.1.12/255.255.255.0/192.168.1.255/apply", "network API order and values")
    network.rejectMask = true
    network.sequence = ""
    Check(not ApplyStaticIPv4(network, profile) And network.sequence = "192.168.1.12/255.255.255.0", "failed setter prevents Apply")

    clock = {IsValid: FakeClockValid, GetZoneDateTime: FakeZonedTime, timeValid: true}
    clock.localTime = {GetHour: FakeHour, GetMinute: FakeMinute, hour: 6, minute: 59}
    Check(not ScheduleAllows(clock, schedule), "off at 06:59")
    clock.localTime.hour = 7
    clock.localTime.minute = 0
    Check(ScheduleAllows(clock, schedule) And clock.zone = "AEST", "wake at 07:00 Sydney")
    clock.localTime.hour = 20
    clock.localTime.minute = 59
    Check(ScheduleAllows(clock, schedule), "on at 20:59")
    clock.localTime.hour = 21
    clock.localTime.minute = 0
    Check(not ScheduleAllows(clock, schedule), "standby at 21:00")
    clock.timeValid = false
    clock.localTime.hour = 12
    Check(not ScheduleAllows(clock, schedule), "invalid RTC stays out of the on window")

    standbyVideo = {StopClear: FakeStopClear, cleared: false}
    SetDisplayState(standbyVideo, invalid, false)
    Check(standbyVideo.cleared, "standby stops playback even without a CEC interface")

    video = {
        PlayFile: FakePlayFile
        accept: true
        calls: 0
    }
    manager = {Synchronize: FakeSynchronize, SetAsLeader: FakeSetAsLeader, fail: false}
    device = {HasFeature: FakeHasFeature}
    Check(SetNativeLeader(manager, device, true) And manager.leader, "native leader mode")
    Check(SetNativeLeader(manager, device, false) And not manager.leader, "native follower mode")
    clip = "SD:/media/FrameCounter_A.mp4"
    Check(StartLeaderCycle(manager, video, clip, "counter-r1-seamless-", 1), "leader play")
    Check(manager.id = "counter-r1-seamless-1" And manager.delay = 500, "native schedule")
    Check(video.lastInput.Filename = clip, "leader local path")
    Check(video.lastInput.SyncDomain = "bench", "domain propagated")
    Check(video.lastInput.SyncId = manager.id, "ID propagated")
    Check(video.lastInput.SyncIsoTimestamp = "20261126T160000,500", "timestamp propagated verbatim")

    event = FakeEvent("counter-r1-seamless-1", "20261126T160000,500")
    followerClip = "SD:/media/FrameCounter_C.mp4"
    Check(PlayNative(video, followerClip, event), "follower play")
    Check(video.lastInput.Filename = followerClip, "follower local path")
    Check(video.lastInput.SyncIsoTimestamp = "20261126T160000,500", "follower uses original start time")
    Check(not PlayNative(video, clip, FakeEvent("missing-time", "")), "missing native timestamp")
    Check(video.calls = 2, "no untimed play")

    manager.fail = true
    Check(not StartLeaderCycle(manager, video, clip, "counter-r1-seamless-", 2), "schedule failure propagated")
    Check(video.calls = 2, "failed sync did not call player")
    video.accept = false
    Check(not PlayNative(video, clip, event), "native player rejection propagated")
    Check(video.calls = 3, "decoder mock exercised")

    m.holding = invalid
    localVideo = {PlayFile: FakePlayFile, accept: true, calls: 0}
    localPanel = {ready: true, screens: true, base: invalid, settings: {overlay: ""}, role: "standalone", source: "built-in", asset: "", baseline: clip, manager: invalid, video: localVideo}
    Check(StartPanel(localPanel), "standalone starts with no SyncManager")
    Check(localVideo.lastInput.Filename = clip And localVideo.lastInput.SyncIsoTimestamp = invalid, "standalone sends only the local file to the decoder")
    localVideo.Pause = FakePause
    localVideo.Resume = FakeResume
    localPanel.state = "playing"
    Check(PanelTransport(localPanel, "pause", "") = "" And localPanel.state = "paused", "local pause")
    Check(PanelTransport(localPanel, "resume", "20261126T160000,500") = "" And localPanel.state = "playing", "transport resumes")
    Check(localVideo.transportStamp = "20261126T160000,500", "native transport keeps its timestamp")
    If m.failures = 0 Then Print "NATIVE_MOCK_TESTS_PASSED"
End Sub

Sub Check(condition As Boolean, description As String)
    If not condition Then
        m.failures = m.failures + 1
        Print "FAIL: "; description
    End If
End Sub

Function UpTime(units As Integer) As Float
    Return 60.0
End Function

Function FakeSynchronize(id As String, delay As Integer) As Dynamic
    m.id = id
    m.delay = delay
    If m.fail Then Return invalid
    Return FakeEvent(id, "20261126T160000,500")
End Function

Function FakePlayFile(params As Object) As Boolean
    m.calls = m.calls + 1
    m.lastInput = params
    Return m.accept
End Function

Function FakePause(params As Object) As Boolean
    m.transportStamp = params.SyncIsoTimeStamp
    Return true
End Function

Function FakeResume(params As Object) As Boolean
    m.transportStamp = params.SyncIsoTimeStamp
    Return true
End Function

Function FakeEvent(id As String, timestamp As String) As Object
    Return {
        id: id
        timestamp: timestamp
        GetDomain: FakeDomain
        GetId: FakeId
        GetIsoTimestamp: FakeTimestamp
    }
End Function

Function FakeDomain() As String
    Return "bench"
End Function

Function FakeId() As String
    Return m.id
End Function

Function FakeTimestamp() As String
    Return m.timestamp
End Function


Function FakeHasFeature(feature As String) As Boolean
    Return false
End Function

Function FakeSetAsLeader(leader As Boolean) As Boolean
    m.leader = leader
    Return true
End Function

Function FakeSetIP(address As String) As Boolean
    m.sequence = address
    Return true
End Function

Function FakeSetMask(mask As String) As Boolean
    m.sequence = m.sequence + "/" + mask
    Return not m.rejectMask
End Function

Function FakeSetBroadcast(broadcast As String) As Boolean
    m.sequence = m.sequence + "/" + broadcast
    Return true
End Function

Function FakeApply() As Boolean
    m.sequence = m.sequence + "/apply"
    Return true
End Function

Function FakeClockValid() As Boolean
    Return m.timeValid
End Function

Function FakeZonedTime(zone As String) As Object
    m.zone = zone
    Return m.localTime
End Function

Function FakeHour() As Integer
    Return m.hour
End Function

Function FakeMinute() As Integer
    Return m.minute
End Function

Function FakeStopClear() As Boolean
    m.cleared = true
    Return true
End Function
