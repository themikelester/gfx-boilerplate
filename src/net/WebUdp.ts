import { EventDispatcher } from "../EventDispatcher";
import { SignalSocket, SignalSocketEvents, ClientId } from "./SignalSocket";

export enum WebUdpEvent {
    Open = "open",
    Close = "close",
    Message = "message",
};

interface ClientMessageData {
    offer?: RTCSessionDescriptionInit,
    answer?: RTCSessionDescriptionInit,
    iceCandidate?: RTCIceCandidate,
}

export class WebUdpSocket extends EventDispatcher {
    signalSocket: SignalSocket;
    peerId: ClientId;

    channel: RTCDataChannel;
    peer: RTCPeerConnection;
    isOpen: boolean = false;

    async connect(signalSocket: SignalSocket, peerId: ClientId) {
        this.peerId = peerId;

        this.signalSocket = signalSocket;
        this.signalSocket.on(SignalSocketEvents.Message, this.onMessage.bind(this));

        this.peer = new RTCPeerConnection(signalSocket.iceServers);

        this.peer.onicecandidate = evt => {
            if (evt.candidate) {
                console.debug('WebUDP: Received ICE candidate', evt.candidate);
                signalSocket.send(this.peerId, { iceCandidate: evt.candidate });
            } else {
                console.debug('WebUDP: Received all ICE candidates');
            }
        };

        const isRemote = this.signalSocket.serverId !== this.signalSocket.clientId

        if (isRemote) {
            // If we're the "remote", we have to listen for a datachannel to open
            this.peer.ondatachannel = evt => {
                this.setDataChannel(evt.channel);
            };
        } else {
            // But if we're the "local", we create the data channel
            const channel = this.peer.createDataChannel('webudp', {
                ordered: false,
                maxRetransmits: 0,
            });
            this.setDataChannel(channel);
            
            // And initiate the connection by creating and sending an offer
            const offer = await this.peer.createOffer();
            await this.peer.setLocalDescription(offer);
            signalSocket.send(this.peerId, { offer });
        }
    }

    async onMessage(msg: ClientMessageData, from: ClientId) {
        // Ignore messages that are not from our peer 
        // (there may be multiple WebRTC handshakes in flight on this signalling socket)
        if (from !== this.peerId) {
            return;
        }

        console.debug('WebUDP: Received message', msg);

        if (msg.answer) {
            console.debug('WebUDP: Received answer', msg.answer);
            this.peer.setRemoteDescription(msg.answer);
        }

        // Construct an answer and send it back to our peer via the signal server
        if (msg.offer) {
            await this.peer.setRemoteDescription(msg.offer);
            const answer = await this.peer.createAnswer();
            this.peer.setLocalDescription(answer);
            this.signalSocket.send(this.peerId, { answer });
        }

        if (msg.iceCandidate) {
            this.peer.addIceCandidate(msg.iceCandidate);
        }
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView): boolean {
        if (this.isOpen) {
            this.channel.send(data as any);
            return true;
        }

        return false;
    };

    close() {
        this.channel.close();
    };

    private setDataChannel(dataChannel: RTCDataChannel) {
        dataChannel.binaryType = 'arraybuffer';
        dataChannel.onopen = () => { this.isOpen = true; this.fire(WebUdpEvent.Open); }
        dataChannel.onclose = () => { this.isOpen = false; this.fire(WebUdpEvent.Close); }
        dataChannel.onerror = evt => { console.error("WebUdpPeer: Data channel error", evt); }
        dataChannel.onmessage = msg => { this.fire(WebUdpEvent.Message, msg); }
        this.channel = dataChannel;
    }
}

export class WebUdpSocketServer extends EventDispatcher {
    address: string;
    isOpen: boolean = false;

    channel: RTCDataChannel;
    peer: RTCPeerConnection;

    constructor(address: string) {
        super();
        this.address = address;
    }

    async connect() {
        var socket = this;

        // @TODO: Pick more ICE servers? Support TURN?
        // @NOTE: Firefox requires a TURN server to work
        this.peer = new RTCPeerConnection({
            iceServers: [{
                urls: ["stun:stun.l.google.com:19302"]
            }]
        });

        this.peer.onicecandidate = function (evt) {
            if (evt.candidate) {
                console.debug("WebUDP: Received ice candidate", evt.candidate);
            } else {
                console.debug("WebUDP: All local candidates received");
            }
        };

        this.peer.ondatachannel = function (evt) {
            console.debug("WebUDP: Peer connection on data channel", evt);
        };

        this.channel = this.peer.createDataChannel("webudp", {
            ordered: false,
            maxRetransmits: 0
        });
        this.channel.binaryType = "arraybuffer";

        this.channel.onopen = function () {
            console.debug("WebUDP: Data channel ready");
            socket.isOpen = true;
            socket.fire(WebUdpEvent.Open);
        };

        this.channel.onclose = function () {
            socket.isOpen = false;
            console.debug("WebUDP: Data channel closed");
        };

        this.channel.onerror = function (evt) {
            console.error("WebUDP: Data channel error", evt);
        };

        this.channel.onmessage = function (evt) {
            socket.fire(WebUdpEvent.Message, evt);
        };

        const offer = await this.peer.createOffer();
        await this.peer.setLocalDescription(offer);

        var request = new XMLHttpRequest();
        request.open("POST", socket.address);
        request.onload = async () => {
            if (request.status == 200) {
                const response = JSON.parse(request.responseText);
                await this.peer.setRemoteDescription(new RTCSessionDescription(response.answer));

                var candidate = new RTCIceCandidate(response.candidate);
                await this.peer.addIceCandidate(candidate);
                console.debug("WebUDP: Add remote ice candidate success");
            }
        };
        request.send(this.peer.localDescription!.sdp);
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView): boolean {
        if (this.isOpen) {
            this.channel.send(data as any);
            return true;
        }

        return false;
    };

    close() {
        this.channel.close();
    };
}