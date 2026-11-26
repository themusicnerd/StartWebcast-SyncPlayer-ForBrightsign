' Roku interpreter desktop test. The hardware objects below are associative-array fakes.
Sub Main()
    m.systemLog = invalid
    m.playerId = "A"
    m.failures = 0

    config = ParseJson("{""schema_version"":1,""group_id"":""bench"",""ptp_domain"":15,""apply_ptp_settings"":false,""enable_genlock"":false,""loop_mode"":""seamless"",""leader_id"":""A"",""players"":{""192.168.1.11"":""A"",""192.168.1.12"":""B""}}")
    Check(ValidConfig(config), "valid configuration")
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
    If m.failures = 0 Then Print "NATIVE_MOCK_TESTS_PASSED"
End Sub

Sub Check(condition As Boolean, description As String)
    If not condition Then
        m.failures = m.failures + 1
        Print "FAIL: "; description
    End If
End Sub

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
