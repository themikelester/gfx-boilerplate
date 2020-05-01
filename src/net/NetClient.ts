import { NetChannel, NetChannelEvent, AckInfo } from "./NetChannel";
import { assert, defined, assertDefined } from "../util";
import { WebUdpSocket, WebUdpEvent } from "./WebUdp";
import { UserCommandBuffer, UserCommand } from "../UserCommand";
import { EventDispatcher } from "../EventDispatcher";
import { ClientId } from "./SignalSocket";
import { SnapshotManager, Snapshot } from "../Snapshot";
import { NetGraphPacketStatus, NetGraphPanel } from "./NetDebug";
import { Buf } from "../Buf";

export enum NetClientState {
    Free,
    Connected,
    Disconnected,

    // The Quake 3 Arena states:
    // CS_FREE,		// can be reused for a new connection
    // CS_ZOMBIE,		// client has been disconnected, but don't reuse
    // 				// connection for a couple seconds
    // CS_CONNECTED,	// has been assigned to a client_t, but no gamestate yet
    // CS_PRIMED,		// gamestate has been sent, but client hasn't sent a usercmd
    // CS_ACTIVE		// client is fully in game
}

export enum NetClientEvents {
    Connected = 'con',
    Disconnected = 'dis',
    Message = 'msg',
    Acknowledge = 'ack',
}

enum MsgId {
    ServerFrame = 0,
    ClientFrame = 1,
    VisChange = 2,

    _Count
}

const kIsMsgIdReliable = [false, false, true];
assert(kIsMsgIdReliable.length === MsgId._Count);

const kMsgIdMask  = 0b00000111;
const kParityShift = 3;

assert((kMsgIdMask+1) >= MsgId._Count, "Don't forget to update the bitmask!");


export class NetClient extends EventDispatcher {
    id: string;
    state: NetClientState = NetClientState.Free;

    ping?: number = -1;

    lastRequestedFrame: number = -1;
    lastReceivedFrame: number = -1;
    lastTransmittedFrame: number = -1;
    lastAcknowledgedFrame: number = -1;

    channel: NetChannel;

    private snapshot: SnapshotManager = new SnapshotManager();
    private userCommands: UserCommandBuffer = new UserCommandBuffer();

    private reliableBuf: Uint8Array[] = [];
    private reliableFrame?: number;
    private reliableSendParity = 0;
    private reliableRecvParity = 0;

    // Debugging
    graphPanel?: NetGraphPanel;

    private initialize(socket: WebUdpSocket) {
        assert(this.state === NetClientState.Free);
        console.debug(`NetClient: ${this.id} is attempting to connect`);

        socket.on(WebUdpEvent.Open, () => {
            console.debug(`NetClient: ${this.id} connected`);
            this.state = NetClientState.Connected;
            this.fire(NetClientEvents.Connected);
        });

        socket.on(WebUdpEvent.Close, () => {
            console.debug(`NetClient: ${this.id} disconnected`);
            this.state = NetClientState.Disconnected;
            this.fire(NetClientEvents.Disconnected);
        });

        this.channel = new NetChannel();

        this.channel.on(NetChannelEvent.Receive, this.onMessage.bind(this));
        this.channel.on(NetChannelEvent.Acknowledge, this.onAck.bind(this));
        this.channel.initialize(socket);
    }

    /**
     * The Client calls this to connect to a specific ClientID that will act as the server
     */
    async connect(serverId: ClientId) {
        const socket = new WebUdpSocket();

        // Wait for the WebUdp socket to be assigned a ClientID by the signalling server
        await socket.connect(serverId);
        this.id = socket.clientId;

        this.initialize(socket);
    }

    /**
     * Accept a connection to a Client's NetClient produced by a WebUdpSocketFactory.
     */
    accept(socket: WebUdpSocket) {
        this.id = socket.peerId;
        this.initialize(socket);
    }

    setNetGraphPanel(graphPanel: NetGraphPanel) {
        this.graphPanel = graphPanel;
    }

    transmitClientFrame(frame: number, cmd: UserCommand) {
        // Buffer this frame's command so that we can retransmit if it is dropped
        assert(frame === cmd.frame);
        this.userCommands.setUserCommand(cmd);

        // Construct the message
        const buf = this.channel.allocatePacket();

        // Write any reliable messages
        if (defined(this.reliableBuf[0])) {
            buf.write(this.reliableBuf[0]);
            if (!defined(this.reliableFrame)) this.reliableFrame = frame; 
        }

        // Write the user commands
        this.sendClientFrame(buf, frame, cmd);

        this.channel.send(buf, frame);
        this.lastTransmittedFrame = frame;

        this.channel.computeStats();
    }

    sendClientFrame(buf: Buf, frame: number, cmd: UserCommand) {
        let idByte = MsgId.ClientFrame;
        let cmdCount = 0;

        const idByteOffset = Buf.writeChar(buf, idByte); // Client frame
        Buf.writeInt(buf, frame); // Frame number

        // Send all unacknowledged user commands 
        // @TODO: This could be smarter, we really only need to send the user commands that the server can still use
        const oldestCmdFrame = Math.max(this.lastAcknowledgedFrame, frame - 5, 0);
        for (let i = frame; i >= oldestCmdFrame; i--) {
            const cmd = this.userCommands.getUserCommand(i);
            if (!defined(cmd)) break;

            assert(cmd.frame === i);

            cmdCount += 1;
            UserCommand.serialize(buf, cmd);
        }

        // Use the upper nibble of the ID byte to store the command count
        idByte |= cmdCount << 4;
        buf.data[idByteOffset] = idByte;
    }

    receiveClientFrame(msg: Buf) {
        const count = Buf.readByte(msg) >> 4;
        const frame = Buf.readInt(msg);

        for (let i = 0; i < count; i++) {
            const cmd = {} as UserCommand;
            UserCommand.deserialize(cmd, msg);

            cmd.frame = frame - i;

            // If we haven't already received this command, buffer it
            const newlySet = this.userCommands.setUserCommand(cmd);

            if (newlySet) {
                if (this.graphPanel) {
                    const received = (frame === cmd.frame) ? NetGraphPacketStatus.Received : NetGraphPacketStatus.Filled;
                    const status = (frame <= this.lastRequestedFrame) ? NetGraphPacketStatus.Late : received;
                    this.graphPanel.setPacketStatus(cmd.frame, status);
                }
            }
        }

        this.lastReceivedFrame = frame;
    }

    transmitServerFrame(snap: Snapshot) {
        // Buffer the state so that we can delta-compare later
        this.snapshot.setSnapshot(snap);

        const buf = this.channel.allocatePacket();
        Buf.writeByte(buf, 0); // Server frame

        // Send the latest state
        Snapshot.serialize(buf, snap);

        this.channel.send(buf, snap.frame);
        this.lastTransmittedFrame = snap.frame;

        this.channel.computeStats();
    }

    receiveServerFrame(msg: Buf) {
        Buf.skip(msg, 1);

        const snap = new Snapshot();
        Snapshot.deserialize(msg, snap);
        this.snapshot.setSnapshot(snap);

        this.lastReceivedFrame = snap.frame;

        if (this.graphPanel) {
            // Mark non-received frames between the last requested and now as filled
            // @NOTE: If they come later (but before they're requested) they can still mark themselves as received
            for (let i = this.lastRequestedFrame + 1; i < snap.frame; i++) {
                if (!this.snapshot.hasSnapshot(i)) this.graphPanel.setPacketStatus(i, NetGraphPacketStatus.Filled);
            }

            const status = (snap.frame <= this.lastRequestedFrame) ? NetGraphPacketStatus.Late : NetGraphPacketStatus.Received;
            this.graphPanel.setPacketStatus(snap.frame, status);
        }
    }
    
    transmitVisibilityChange(visible: boolean) {
        let bits = 0;
        if (visible) bits |= 0xF0;
        bits |= MsgId.VisChange & kMsgIdMask;
        bits |= (this.reliableSendParity & 1) << kParityShift;
        this.reliableSendParity ^= 1; 
        
        this.reliableBuf.push(new Uint8Array([bits]));
    }

    receiveVisibilityChange(msg: Buf, ignore: boolean) {
        const visible = (Buf.readByte(msg) & ~kMsgIdMask) > 0;
        if (!ignore) {
            console.log(`[Client ${this.id}] Received new visibility status: ${visible ? 'visible' : 'hidden' }`);
        }
    }

    getSnapshot(frame: number, dst: Snapshot) {
        this.lastRequestedFrame = Math.ceil(frame);
        return this.snapshot.lerpSnapshot(frame, dst);
    }

    getUserCommand(frame: number) {
        this.lastRequestedFrame = frame;
        let cmd = this.userCommands.getUserCommand(frame);

        // If we have not yet received an input for this frame, complain, and use the most recent
        if (!defined(cmd)) {
            console.warn(`[Client ${this.id}] Missing input for frame ${frame}`);
            cmd = this.userCommands.getUserCommand();
        }

        return assertDefined(cmd);
    }

    onAck(ack: AckInfo) {
        const frame = ack.tag;
        if (frame > this.lastAcknowledgedFrame) {
            this.lastAcknowledgedFrame = frame;
        }

        if (this.reliableBuf[0] && frame >= this.reliableFrame!) {
            // The in-flight reliable message has been acknowledged, stop sending it
            this.reliableBuf.shift();
            this.reliableFrame = undefined;
        }

        this.fire(NetClientEvents.Acknowledge, ack);
    }

    onMessage(msg: Buf) {
        this.ping = this.channel.ping;

        while (msg.offset < msg.data.byteLength) {
            const idByte = Buf.peekByte(msg)
            const msgId = idByte & kMsgIdMask;
            const reliableParity = (idByte >> kParityShift) & 1;
            let error = false;

            // If we've already received this reliable message, ignore
            const ignoreReliable = reliableParity != this.reliableRecvParity;
            if (kIsMsgIdReliable[msgId] && !ignoreReliable) {
                this.reliableRecvParity ^= 1;
            }

            switch(msgId) {
                case MsgId.ServerFrame: this.receiveServerFrame(msg); break;
                case MsgId.ClientFrame: this.receiveClientFrame(msg); break;
                case MsgId.VisChange: this.receiveVisibilityChange(msg, ignoreReliable); break;
                default: console.warn('Received unknown message. Ignoring.'); error = true; break; 
            }

            if (error) break;
        }

        this.fire(NetClientEvents.Message, msg);
    }
}