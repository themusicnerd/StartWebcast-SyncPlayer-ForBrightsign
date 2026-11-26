Sub Main()
    m.systemLog = CreateObject("roSystemLog")
    m.playerId = ""
    port = CreateObject("roMessagePort")
    RunBench(port)
    ' A boot or playback fault leaves the player idle for diagnosis.
    While true
        Wait(0, port)
    End While
End Sub

Sub RunBench(port As Object)
    device = CreateObject("roDeviceInfo")
    If device = invalid Then
        LogEvent("DEVICE_INFO_UNAVAILABLE", {})
        Return
    End If
    model = device.GetModel()
    LogEvent("BOOT", {model: model, firmware: device.GetVersion(), device_id: device.GetDeviceUniqueId()})
    If UCase(model) <> "XD236" Then
        LogEvent("UNSUPPORTED_MODEL", {model: model})
        Return
    End If

    root = GetDefaultDrive()
    config = ParseJson(ReadAsciiFile(root + "syncplayer.json"))
    If not ValidConfig(config) Then
        LogEvent("INVALID_CONFIG", {})
        Return
    End If

    network = CreateObject("roNetworkConfiguration", "eth0")
    If network = invalid Then
        LogEvent("NETWORK_INTERFACE_UNAVAILABLE", {interface_name: "eth0"})
        Return
    End If
    address = WaitForAddress(network, config.players, port)
    If address = "" Then Return

    m.playerId = config.players[address]
    leader = (m.playerId = config.leader_id)
    mediaPath = root + "media/FrameCounter_" + m.playerId + ".mp4"
    LogEvent("ROLE_ASSIGNED", {ip: address, leader: leader, group: config.group_id, loop_mode: config.loop_mode})

    video = CreateObject("roVideoPlayer")
    mode = CreateObject("roVideoMode")
    If video = invalid Or mode = invalid Then
        LogEvent("NATIVE_VIDEO_UNAVAILABLE", {})
        Return
    End If
    playable = video.GetFilePlayability(mediaPath)
    If playable = invalid Then
        LogEvent("LOCAL_CLIP_PROBE_FAILED", {path: mediaPath})
        Return
    End If
    If playable.file <> "playable" Or playable.video <> "playable" Then
        LogEvent("LOCAL_CLIP_UNPLAYABLE", {path: mediaPath, probe: playable})
        Return
    End If

    If not EnsurePtp(config) Then Return
    targetMode = "1920x1080x60p"
    previousMode = mode.GetMode()
    If previousMode <> targetMode Then
        LogEvent("SET_OUTPUT_MODE", {previous: previousMode, requested: targetMode})
        ' A real mode change normally restarts the application on Series 6.
        If not mode.SetMode(targetMode) Then
            LogEvent("OUTPUT_MODE_REJECTED", {requested: targetMode})
            Return
        End If
    End If

    If mode.GetMode() <> targetMode Then
        LogEvent("OUTPUT_MODE_MISMATCH", {actual: mode.GetMode(), requested: targetMode})
        Return
    End If

    manager = CreateObject("roSyncManager", {Domain: config.group_id})
    If manager = invalid Then
        LogEvent("SYNC_MANAGER_UNAVAILABLE", {})
        Return
    End If
    manager.SetPort(port)
    If not SetNativeLeader(manager, device, leader) Then
        LogEvent("SYNC_ROLE_REJECTED", {leader: leader})
        Return
    End If
    If config.enable_genlock Then
        If not mode.SetSyncDomain(config.group_id) Then
            LogEvent("GENLOCK_REQUEST_REJECTED", {})
            Return
        End If
    End If

    loopSetting = "NoLoop"
    If config.loop_mode = "seamless" Then loopSetting = "SeamlessLoopOrNotAtAll"
    If not video.SetLoopMode(loopSetting) Then
        LogEvent("LOOP_SETTING_REJECTED", {mode: loopSetting})
        Return
    End If
    video.SetPort(port)

    syncPrefix = "counter-r1-" + config.loop_mode + "-"
    sequence = 1
    lastTimestamp = ""
    lastId = ""
    LogEvent("NATIVE_READY", {output_mode: mode.GetMode(), ptp_domain: config.ptp_domain, genlock_requested: config.enable_genlock, sync_quality: "unknown"})

    If leader Then
        ' Allow the wired clock service to settle. This does not establish lock.
        Sleep(10000)
        If not StartLeaderCycle(manager, video, mediaPath, syncPrefix, sequence) Then Return
    End If

    While true
        event = Wait(0, port)
        eventType = Type(event)
        If eventType = "roSyncManagerEvent" And not leader Then
            syncId = event.GetId()
            timestamp = event.GetIsoTimestamp()
            If event.GetDomain() = config.group_id And Left(syncId, Len(syncPrefix)) = syncPrefix And Len(syncId) <= 64 And Len(timestamp) > 0 And Len(timestamp) <= 64 Then
                If syncId <> lastId Or timestamp <> lastTimestamp Then
                    lastId = syncId
                    lastTimestamp = timestamp
                    PlayNative(video, mediaPath, event)
                End If
            End If
        Else If eventType = "roVideoEvent" Then
            eventCode = event.GetInt()
            LogEvent("NATIVE_VIDEO_EVENT", {code: eventCode})
            If eventCode = 8 Then
                If config.loop_mode = "seamless" Then
                    video.StopClear()
                    LogEvent("SEAMLESS_MEDIA_ENDED", {})
                    Return
                End If
                If leader Then
                    sequence = sequence + 1
                    If not StartLeaderCycle(manager, video, mediaPath, syncPrefix, sequence) Then Return
                End If
            End If
        End If
    End While
End Sub

Function ValidConfig(config As Dynamic) As Boolean
    If Type(config) <> "roAssociativeArray" Then Return false
    If not WholeNumber(config.schema_version) Then Return false
    If config.schema_version <> 1 Then Return false
    If not WholeNumber(config.ptp_domain) Then Return false
    If config.ptp_domain < 0 Or config.ptp_domain > 127 Then Return false
    If not BooleanValue(config.apply_ptp_settings) Or not BooleanValue(config.enable_genlock) Then Return false
    If not TextValue(config.loop_mode) Then Return false
    If config.loop_mode <> "seamless" And config.loop_mode <> "reschedule" Then Return false
    If not TextValue(config.group_id) Or not TextValue(config.leader_id) Then Return false
    If Len(config.group_id) < 1 Or Len(config.group_id) > 48 Then Return false
    For index = 1 To Len(config.group_id)
        If Instr(1, "abcdefghijklmnopqrstuvwxyz0123456789-", Mid(config.group_id, index, 1)) = 0 Then Return false
    End For
    If Type(config.players) <> "roAssociativeArray" Then Return false
    If config.players.Count() < 2 Or config.players.Count() > 26 Then Return false

    ids = {}
    For Each address In config.players
        playerId = config.players[address]
        If not TextValue(playerId) Then Return false
        If Len(playerId) <> 1 Then Return false
        If Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", playerId) = 0 Then Return false
        If ids.DoesExist(playerId) Then Return false
        ids[playerId] = true
    End For
    If Len(config.leader_id) <> 1 Then Return false
    If Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", config.leader_id) = 0 Then Return false
    Return ids.DoesExist(config.leader_id)
End Function

Function WholeNumber(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "Integer" Or kind = "roInt" Or kind = "roInteger"
End Function

Function BooleanValue(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "Boolean" Or kind = "roBoolean"
End Function

Function TextValue(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "String" Or kind = "roString"
End Function

Function WaitForAddress(network As Object, players As Object, port As Object) As String
    LogEvent("WAITING_FOR_ETH0", {})
    address = ""
    For attempt = 1 To 45
        current = network.GetCurrentConfig()
        If current <> invalid Then
            address = current.ip4_address
            If current.link And address <> "" And players.DoesExist(address) Then Return address
        End If
        Wait(1000, port)
    End For
    LogEvent("ETH0_ADDRESS_UNASSIGNED", {last_ip: address})
    Return ""
End Function

Function EnsurePtp(config As Object) As Boolean
    registry = CreateObject("roRegistrySection", "networking")
    If registry = invalid Then
        LogEvent("REGISTRY_UNAVAILABLE", {})
        Return false
    End If
    wantedDomain = Mid(StrI(config.ptp_domain), 2)
    currentDomain = registry.Read("ptp_domain")
    currentInterface = registry.Read("ptp_interface")
    interfaceMatches = (currentInterface = "" Or currentInterface = "eth0")
    If currentDomain = wantedDomain And interfaceMatches Then Return true

    If not config.apply_ptp_settings Then
        LogEvent("PTP_SETUP_REQUIRED", {current_domain: currentDomain, current_interface: currentInterface, requested_domain: wantedDomain})
        Return false
    End If
    LogEvent("PTP_SETUP", {previous_domain: currentDomain, previous_interface: currentInterface, requested_domain: wantedDomain})
    If not interfaceMatches Then
        If not registry.Write("ptp_interface", "eth0") Then
            LogEvent("PTP_INTERFACE_WRITE_FAILED", {})
            Return false
        End If
    End If
    If currentDomain <> wantedDomain Then
        If not registry.Write("ptp_domain", wantedDomain) Then
            LogEvent("PTP_DOMAIN_WRITE_FAILED", {})
            Return false
        End If
    End If
    If not registry.Flush() Then
        LogEvent("PTP_FLUSH_FAILED", {})
        Return false
    End If
    LogEvent("PTP_REBOOT", {})
    RebootSystem()
    Return false
End Function

Function SetNativeLeader(manager As Object, device As Object, leader As Boolean) As Boolean
    If not device.HasFeature("FindMemberFunction") Then Return manager.SetAsLeader(leader)
    If FindMemberFunction(manager, "SetAsLeader") <> invalid Then Return manager.SetAsLeader(leader)
    ' The vendor example uses this alternative name, without a return signature.
    If FindMemberFunction(manager, "SetLeaderMode") = invalid Then Return false
    manager.SetLeaderMode(leader)
    current = manager.GetCurrentConfig()
    If current = invalid Then Return false
    expected = 0
    If leader Then expected = 1
    LogEvent("SYNC_ROLE_EXAMPLE_METHOD", {leader: leader})
    Return current.leader = expected
End Function

Function StartLeaderCycle(manager As Object, video As Object, path As String, prefix As String, sequence As Integer) As Boolean
    syncId = prefix + Mid(StrI(sequence), 2)
    event = manager.Synchronize(syncId, 500)
    If event = invalid Then
        LogEvent("SYNC_SCHEDULE_FAILED", {sync_id: syncId})
        Return false
    End If
    Return PlayNative(video, path, event)
End Function

Function PlayNative(video As Object, path As String, event As Object) As Boolean
    params = {
        Filename: path
        SyncDomain: event.GetDomain()
        SyncId: event.GetId()
        SyncIsoTimestamp: event.GetIsoTimestamp()
    }
    If params.SyncIsoTimestamp = "" Then
        LogEvent("SYNC_TIMESTAMP_MISSING", {sync_id: params.SyncId})
        Return false
    End If

    accepted = video.PlayFile(params)
    fields = {sync_id: params.SyncId, native_timestamp: params.SyncIsoTimestamp}
    If accepted Then
        LogEvent("NATIVE_PLAY_REQUESTED", fields)
    Else
        LogEvent("NATIVE_PLAY_REJECTED", fields)
    End If
    Return accepted
End Function

Sub LogEvent(eventName As String, fields As Object)
    fields.app = "Start SyncPlayer"
    fields.version = "0.1.0"
    fields.event = eventName
    fields.player_id = m.playerId
    line = FormatJson(fields)
    Print line
    If m.systemLog <> invalid Then m.systemLog.SendLine(line)
End Sub
