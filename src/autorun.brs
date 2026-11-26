Sub Main()
    m.systemLog = CreateObject("roSystemLog")
    m.playerId = ""
    port = CreateObject("roMessagePort")
    m.holding = invalid
    RunPlayback(port)
    ' Leave the display idle for diagnosis after a boot or playback fault.
    While true
        Wait(0, port)
    End While
End Sub

Sub RunPlayback(port As Object)
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

    cardId = config.card_player_id
    network = CreateObject("roNetworkConfiguration", "eth0")
    If network = invalid Then
        LogEvent("NETWORK_INTERFACE_UNAVAILABLE", {interface_name: "eth0"})
        Return
    End If
    If config.static_ipv4 <> invalid Then
        m.playerId = cardId
        If not ProvisionStaticIPv4(network, config.static_ipv4, port) Then Return
    End If

    scheduled = config.display_schedule <> invalid
    clock = invalid
    If scheduled Then
        clock = CreateObject("roSystemTime")
        If clock = invalid Then
            LogEvent("SCHEDULE_CLOCK_UNAVAILABLE", {})
        Else If UCase(clock.GetTimeZone()) <> "AEST" Then
            If not clock.SetTimeZone("AEST") Then LogEvent("TIME_ZONE_REJECTED", {})
        End If
    End If

    mode = CreateObject("roVideoMode")
    If mode = invalid Then
        LogEvent("VIDEO_MODE_UNAVAILABLE", {})
        Return
    End If
    If cardId <> invalid Then m.holding = ShowHolding(mode, root + "media/HOLDING.jpeg")

    address = WaitForAddress(network, config.players, port)
    If address = "" Then Return

    m.playerId = config.players[address]
    leader = (m.playerId = config.leader_id)
    targetMode = "1920x1080x60p"
    mediaName = "FrameCounter_" + m.playerId + ".mp4"
    contentId = "counter-r1"
    If cardId <> invalid Then
        If cardId <> m.playerId Then
            LogEvent("WRONG_PLAYER_CARD", {card_id: cardId, ip: address})
            Return
        End If
        targetMode = config.output_mode
        mediaName = "Presentation_" + m.playerId + ".mp4"
        contentId = "presentation-r1"
    End If
    mediaPath = root + "media/" + mediaName
    LogEvent("ROLE_ASSIGNED", {ip: address, leader: leader, group: config.group_id, loop_mode: config.loop_mode})

    video = CreateObject("roVideoPlayer")
    If video = invalid Then
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

    If cardId <> invalid Then
        ' The first image was drawn in the boot-time graphics plane.
        If previousMode <> targetMode Then
            m.holding = invalid
            m.holding = ShowHolding(mode, root + "media/HOLDING.jpeg")
        End If
        If not ConfigureCardAudio(video, leader) Then Return
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

    syncPrefix = contentId + "-" + config.loop_mode + "-"
    wakePrefix = contentId + "-wake-"
    sleepPrefix = contentId + "-standby-"
    sequence = 0
    lastTimestamp = ""
    lastId = ""
    screensOn = not scheduled
    previousSchedule = invalid
    cec = invalid
    waitMs = 0
    If scheduled Then
        cec = CreateObject("roCecInterface")
        If cec = invalid Then LogEvent("CEC_UNAVAILABLE", {})
        If m.holding <> invalid Then m.holding.Hide()
        If leader Then waitMs = 1000
    End If
    LogEvent("NATIVE_READY", {output_mode: mode.GetMode(), ptp_domain: config.ptp_domain, genlock_requested: config.enable_genlock, sync_quality: "unknown"})

    If leader Then
        ' Allow the wired clock service to settle. This does not establish lock.
        Sleep(10000)
        If not scheduled Then
            sequence = 1
            If not StartLeaderCycle(manager, video, mediaPath, syncPrefix, sequence) Then Return
        End If
    End If

    While true
        If leader And scheduled Then
            desired = ScheduleAllows(clock, config.display_schedule)
            If previousSchedule = invalid Or desired <> previousSchedule Then
                previousSchedule = desired
                screensOn = desired
                sequence = sequence + 1
                statePrefix = sleepPrefix
                If screensOn Then statePrefix = wakePrefix
                stateEvent = manager.Synchronize(statePrefix + Mid(StrI(sequence), 2), 0)
                If stateEvent = invalid Then LogEvent("DISPLAY_STATE_BROADCAST_FAILED", {wake: screensOn})
                SetDisplayState(video, cec, screensOn)

                If screensOn Then
                    ' Screen warm-up is separate from the native playback start.
                    Sleep(8000)
                    If ScheduleAllows(clock, config.display_schedule) Then
                        sequence = sequence + 1
                        If not StartLeaderCycle(manager, video, mediaPath, syncPrefix, sequence) Then Return
                    End If
                End If
            End If
        End If

        event = Wait(waitMs, port)
        eventType = Type(event)
        If eventType = "roSyncManagerEvent" And not leader Then
            syncId = event.GetId()
            timestamp = event.GetIsoTimestamp()
            playing = Left(syncId, Len(syncPrefix)) = syncPrefix
            wake = scheduled And Left(syncId, Len(wakePrefix)) = wakePrefix
            standby = scheduled And Left(syncId, Len(sleepPrefix)) = sleepPrefix
            If event.GetDomain() = config.group_id And (playing Or wake Or standby) And Len(syncId) <= 64 And Len(timestamp) > 0 And Len(timestamp) <= 64 Then
                If syncId <> lastId Or timestamp <> lastTimestamp Then
                    lastId = syncId
                    lastTimestamp = timestamp
                    If standby Then
                        screensOn = false
                        SetDisplayState(video, cec, false)
                    Else
                        If not screensOn Then
                            screensOn = true
                            SetDisplayState(video, cec, true)
                        End If
                        If playing Then PlayNative(video, mediaPath, event)
                    End If
                End If
            End If
        Else If eventType = "roVideoEvent" Then
            eventCode = event.GetInt()
            LogEvent("NATIVE_VIDEO_EVENT", {code: eventCode})
            If eventCode = 8 And screensOn Then
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
    If not ids.DoesExist(config.leader_id) Then Return false
    If config.card_player_id = invalid Then
        Return config.output_mode = invalid And config.static_ipv4 = invalid And config.display_schedule = invalid
    End If
    If not TextValue(config.card_player_id) Or not TextValue(config.output_mode) Then Return false
    If Len(config.card_player_id) <> 1 Or Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", config.card_player_id) = 0 Then Return false
    If not ids.DoesExist(config.card_player_id) Then Return false
    If config.output_mode <> "3840x2160x50p" And config.output_mode <> "1920x1080x50p" Then Return false
    If config.static_ipv4 <> invalid Then
        If not ValidStaticIPv4(config.static_ipv4, config.players, config.card_player_id) Then Return false
    End If
    If config.display_schedule <> invalid Then
        If not ValidDisplaySchedule(config.display_schedule) Or config.loop_mode <> "reschedule" Then Return false
    End If
    Return true
End Function

Function ValidStaticIPv4(profile As Dynamic, players As Object, cardId As String) As Boolean
    If Type(profile) <> "roAssociativeArray" Then Return false
    If not TextValue(profile.address) Or not TextValue(profile.broadcast) Or not TextValue(profile.netmask) Then Return false
    If profile.netmask <> "255.255.255.0" Or players[profile.address] <> cardId Then Return false
    dot = Instr(1, profile.address, ".")
    For index = 1 To 2
        If dot = 0 Then Return false
        dot = Instr(dot + 1, profile.address, ".")
    End For
    If dot = 0 Then Return false
    octet = Mid(profile.address, dot + 1)
    hostNumber = StrToI(octet)
    If hostNumber < 1 Or hostNumber > 254 Or Mid(StrI(hostNumber), 2) <> octet Then Return false
    Return profile.broadcast = Left(profile.address, dot) + "255"
End Function

Function ValidDisplaySchedule(schedule As Dynamic) As Boolean
    If Type(schedule) <> "roAssociativeArray" Then Return false
    If not TextValue(schedule.timezone) Then Return false
    If schedule.timezone <> "Australia/Sydney" Then Return false
    If not TextValue(schedule.on) Or not TextValue(schedule.off) Then Return false
    onMinute = MinuteOfDay(schedule.on)
    offMinute = MinuteOfDay(schedule.off)
    Return onMinute >= 0 And offMinute > onMinute
End Function

Function MinuteOfDay(value As String) As Integer
    If Len(value) <> 5 Or Mid(value, 3, 1) <> ":" Then Return -1
    For Each index In [1, 2, 4, 5]
        If Instr(1, "0123456789", Mid(value, index, 1)) = 0 Then Return -1
    End For
    hours = StrToI(Left(value, 2))
    minutes = StrToI(Right(value, 2))
    If hours > 23 Or minutes > 59 Then Return -1
    Return hours * 60 + minutes
End Function

Function ScheduleAllows(clock As Dynamic, schedule As Object) As Boolean
    If clock = invalid Then Return false
    If not clock.IsValid() Then Return false
    localTime = clock.GetZoneDateTime("AEST")
    If localTime = invalid Then Return false
    current = localTime.GetHour() * 60 + localTime.GetMinute()
    Return current >= MinuteOfDay(schedule.on) And current < MinuteOfDay(schedule.off)
End Function

Sub SetDisplayState(video As Object, cec As Dynamic, wake As Boolean)
    If wake Then
        If m.holding <> invalid Then m.holding.Show()
    Else
        video.StopClear()
        If m.holding <> invalid Then m.holding.Hide()
    End If
    If cec = invalid Then Return

    ' Low nibble 0 addresses the TV. BrightSign supplies the initiator nibble.
    packet = CreateObject("roByteArray")
    If wake Then
        packet.FromHexString("0004") ' Image View On
        cec.SendRawMessage(packet)
        packet = CreateObject("roByteArray")
        packet.FromHexString("0F820000") ' Active Source, with the physical address filled by BrightSign
    Else
        packet.FromHexString("0036") ' Standby
    End If
    cec.SendRawMessage(packet)
    LogEvent("CEC_COMMAND_SENT", {wake: wake})
End Sub

Function ShowHolding(mode As Object, path As String) As Dynamic
    ' Keep the graphics below the hardware video. It remains visible whenever the video plane is clear.
    If not mode.SetGraphicsZOrder("back") Then
        LogEvent("HOLDING_GRAPHICS_ORDER_REJECTED", {})
        Return invalid
    End If
    bounds = CreateObject("roRectangle", 0, 0, mode.GetResX(), mode.GetResY())
    holding = CreateObject("roImageWidget", bounds)
    If holding = invalid Then
        LogEvent("HOLDING_WIDGET_UNAVAILABLE", {})
        Return invalid
    End If
    If not holding.SetDefaultMode(1) Or not holding.DisplayFile(path) Or not holding.Show() Then
        LogEvent("HOLDING_IMAGE_REJECTED", {path: path})
        Return invalid
    End If
    Return holding
End Function

Function ConfigureCardAudio(video As Object, leader As Boolean) As Boolean
    If leader Then
        audio = CreateObject("roAudioOutput", "hdmi")
        If audio <> invalid Then
            If video.SetPcmAudioOutputs(audio) Then Return true
        End If
    Else
        If video.SetVolume(0) Then Return true
    End If
    LogEvent("AUDIO_CONFIGURATION_REJECTED", {leader: leader})
    Return false
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

Function ProvisionStaticIPv4(network As Object, profile As Object, port As Object) As Boolean
    registry = CreateObject("roRegistrySection", "StartSyncPlayer")
    If registry = invalid Then
        RecordStaticStatus("STATIC_IPV4_REGISTRY_UNAVAILABLE", profile.address)
        Return false
    End If
    signature = profile.address + "/" + profile.netmask
    If registry.Read("static_eth0") = signature Then Return true

    If not MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then
        RecordStaticStatus("STATIC_IPV4_APPLYING", profile.address)
        If not ApplyStaticIPv4(network, profile) Then
            RecordStaticStatus("STATIC_IPV4_APPLY_FAILED", profile.address)
            Return false
        End If
        For attempt = 1 To 30
            If MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then Exit For
            Wait(1000, port)
        End For
        If not MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then
            RecordStaticStatus("STATIC_IPV4_NOT_CONFIRMED", profile.address)
            Return false
        End If
    End If
    If not registry.Write("static_eth0", signature) Or not registry.Flush() Then
        RecordStaticStatus("STATIC_IPV4_MARKER_FAILED", profile.address)
        Return false
    End If
    RecordStaticStatus("STATIC_IPV4_READY", profile.address)
    Return true
End Function

Function ApplyStaticIPv4(network As Object, profile As Object) As Boolean
    If not network.SetIP4Address(profile.address) Then Return false
    If not network.SetIP4Netmask(profile.netmask) Then Return false
    If not network.SetIP4Broadcast(profile.broadcast) Then Return false
    Return network.Apply()
End Function

Function MatchesStaticIPv4(current As Dynamic, profile As Object) As Boolean
    If Type(current) <> "roAssociativeArray" Then Return false
    Return current.dhcp = false And current.ip4_address = profile.address And current.ip4_netmask = profile.netmask
End Function

Sub RecordStaticStatus(status As String, address As String)
    LogEvent(status, {ip: address})
    WriteAsciiFile(GetDefaultDrive() + "network-setup.txt", status + " " + address + Chr(13) + Chr(10))
End Sub

Function WaitForAddress(network As Object, players As Object, port As Object) As String
    LogEvent("WAITING_FOR_ETH0", {})
    address = ""
    For attempt = 1 To 45
        current = network.GetCurrentConfig()
        If Type(current) = "roAssociativeArray" Then
            If TextValue(current.ip4_address) Then
                address = current.ip4_address
                If current.link = true And address <> "" And players.DoesExist(address) Then Return address
            End If
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
    fields.version = "0.1.2"
    fields.event = eventName
    fields.player_id = m.playerId
    line = FormatJson(fields)
    Print line
    If m.systemLog <> invalid Then m.systemLog.SendLine(line)
End Sub
