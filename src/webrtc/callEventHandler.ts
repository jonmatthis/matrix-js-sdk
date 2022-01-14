/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { MatrixEvent } from '../models/event';
import { logger } from '../logger';
import { createNewMatrixCall, MatrixCall, CallErrorCode, CallState, CallDirection } from './call';
import { EventType } from '../@types/event';
import { MatrixClient } from '../client';
import { MCallAnswer, MCallHangupReject } from "./callEventTypes";
import { GroupCallError, GroupCallErrorCode, GroupCallEvent } from './groupCall';

// Don't ring unless we'd be ringing for at least 3 seconds: the user needs some
// time to press the 'accept' button
const RING_GRACE_PERIOD = 3000;

export class CallEventHandler {
    client: MatrixClient;
    calls: Map<string, MatrixCall>;
    callEventBuffer: MatrixEvent[];
    candidateEventsByCall: Map<string, Array<MatrixEvent>>;

    private eventBufferPromiseChain?: Promise<void>;

    constructor(client: MatrixClient) {
        this.client = client;
        this.calls = new Map<string, MatrixCall>();
        // The sync code always emits one event at a time, so it will patiently
        // wait for us to finish processing a call invite before delivering the
        // next event, even if that next event is a hangup. We therefore accumulate
        // all our call events and then process them on the 'sync' event, ie.
        // each time a sync has completed. This way, we can avoid emitting incoming
        // call events if we get both the invite and answer/hangup in the same sync.
        // This happens quite often, eg. replaying sync from storage, catchup sync
        // after loading and after we've been offline for a bit.
        this.callEventBuffer = [];
        this.candidateEventsByCall = new Map<string, Array<MatrixEvent>>();
    }

    public start() {
        this.client.on("sync", this.onSync);
        this.client.on("Room.timeline", this.onRoomTimeline);
        this.client.on("toDeviceEvent", this.onToDeviceEvent);
    }

    public stop() {
        this.client.removeListener("sync", this.onSync);
        this.client.removeListener("Room.timeline", this.onRoomTimeline);
        this.client.removeListener("toDeviceEvent", this.onToDeviceEvent);
    }

    private onSync = (): void => {
        // Process the current event buffer and start queuing into a new one.
        const currentEventBuffer = this.callEventBuffer;
        this.callEventBuffer = [];

        // Ensure correct ordering by only processing this queue after the previous one has finished processing
        if (this.eventBufferPromiseChain) {
            this.eventBufferPromiseChain =
                this.eventBufferPromiseChain.then(() => this.evaluateEventBuffer(currentEventBuffer));
        } else {
            this.eventBufferPromiseChain = this.evaluateEventBuffer(currentEventBuffer);
        }
    };

    private onRoomTimeline = (event: MatrixEvent) => {
        this.callEventBuffer.push(event);
    };

    private onToDeviceEvent = (event: MatrixEvent): void => {
        this.callEventBuffer.push(event);
    };

    private async evaluateEventBuffer(eventBuffer: MatrixEvent[]) {
        await Promise.all(eventBuffer.map((event) => this.client.decryptEventIfNeeded(event)));

        const callEvents = eventBuffer.filter((event) => {
            const eventType = event.getType();
            return eventType.startsWith("m.call.") || eventType.startsWith("org.matrix.call.");
        });

        const ignoreCallIds = new Set<String>();

        // inspect the buffer and mark all calls which have been answered
        // or hung up before passing them to the call event handler.
        for (const event of callEvents) {
            const eventType = event.getType();

            if (eventType=== EventType.CallAnswer || eventType === EventType.CallHangup) {
                ignoreCallIds.add(event.getContent().call_id);
            }
        }

        // Process call events in the order that they were received
        for (const event of callEvents) {
            const eventType = event.getType();
            const callId = event.getContent().call_id;

            if (eventType === EventType.CallInvite && ignoreCallIds.has(callId)) {
                // This call has previously been answered or hung up: ignore it
                continue;
            }

            try {
                await this.handleCallEvent(event);
            } catch (e) {
                logger.error("Caught exception handling call event", e);
            }
        }
    }

    private async handleCallEvent(event: MatrixEvent) {
        const content = event.getContent();
        const callRoomId = (
            event.getRoomId() ||
            this.client.groupCallEventHandler.getGroupCallById(content.conf_id)?.room?.roomId
        );
        const groupCallId = content.conf_id;
        const type = event.getType() as EventType;
        const senderId = event.getSender();
        const weSentTheEvent = senderId === this.client.credentials.userId;
        let call = content.call_id ? this.calls.get(content.call_id) : undefined;
        //console.info("RECV %s content=%s", type, JSON.stringify(content));

        let opponentDeviceId: string | undefined;

        if (groupCallId) {
            const groupCall = this.client.groupCallEventHandler.getGroupCallById(groupCallId);

            if (!groupCall) {
                logger.warn(`Cannot find a group call ${groupCallId} for event ${type}. Ignoring event.`);
                return;
            }

            opponentDeviceId = content.device_id;

            if (!opponentDeviceId) {
                logger.warn(`Cannot find a device id for ${senderId}. Ignoring event.`);
                groupCall.emit(
                    GroupCallEvent.Error,
                    new GroupCallError(
                        GroupCallErrorCode.UnknownDevice,
                        `Incoming Call: No opponent device found for ${senderId}, ignoring.`,
                    ),
                );
                return;
            }

            if (content.dest_session_id !== this.client.getSessionId()) {
                logger.warn("Call event does not match current session id, ignoring.");
                return;
            }
        }

        if (!callRoomId) return;

        if (type === EventType.CallInvite) {
            // ignore invites you send
            if (weSentTheEvent) return;
            // expired call
            if (event.getLocalAge() > content.lifetime - RING_GRACE_PERIOD) return;
            // stale/old invite event
            if (call && call.state === CallState.Ended) return;

            if (call) {
                logger.log(
                    `WARN: Already have a MatrixCall with id ${content.call_id} but got an ` +
                    `invite. Clobbering.`,
                );
            }

            if (content.invitee && content.invitee !== this.client.getUserId()) {
                return; // This invite was meant for another user in the room
            }

            const timeUntilTurnCresExpire = this.client.getTurnServersExpiry() - Date.now();
            logger.info("Current turn creds expire in " + timeUntilTurnCresExpire + " ms");
            call = createNewMatrixCall(
                this.client,
                callRoomId,
                {
                    forceTURN: this.client.forceTURN, opponentDeviceId,
                    groupCallId,
                    opponentSessionId: content.sender_session_id,
                },
            );
            if (!call) {
                logger.log(
                    "Incoming call ID " + content.call_id + " but this client " +
                    "doesn't support WebRTC",
                );
                // don't hang up the call: there could be other clients
                // connected that do support WebRTC and declining the
                // the call on their behalf would be really annoying.
                return;
            }

            call.callId = content.call_id;
            await call.initWithInvite(event);
            this.calls.set(call.callId, call);

            // if we stashed candidate events for that call ID, play them back now
            if (this.candidateEventsByCall.get(call.callId)) {
                for (const ev of this.candidateEventsByCall.get(call.callId)) {
                    call.onRemoteIceCandidatesReceived(ev);
                }
            }

            // Were we trying to call that user (room)?
            let existingCall;
            for (const thisCall of this.calls.values()) {
                const isCalling = [CallState.WaitLocalMedia, CallState.CreateOffer, CallState.InviteSent].includes(
                    thisCall.state,
                );

                if (
                    call.roomId === thisCall.roomId &&
                    thisCall.direction === CallDirection.Outbound &&
                    call.getOpponentMember().userId === thisCall.invitee &&
                    isCalling
                ) {
                    existingCall = thisCall;
                    break;
                }
            }

            if (existingCall) {
                if (existingCall.callId > call.callId) {
                    logger.log(
                        "Glare detected: answering incoming call " + call.callId +
                        " and canceling outgoing call " + existingCall.callId,
                    );
                    existingCall.replacedBy(call);
                } else {
                    logger.log(
                        "Glare detected: rejecting incoming call " + call.callId +
                        " and keeping outgoing call " + existingCall.callId,
                    );
                    call.hangup(CallErrorCode.Replaced, true);
                }
            } else {
                this.client.emit("Call.incoming", call);
            }
            return;
        } else if (type === EventType.CallCandidates) {
            if (weSentTheEvent) return;

            if (!call) {
                // store the candidates; we may get a call eventually.
                if (!this.candidateEventsByCall.has(content.call_id)) {
                    this.candidateEventsByCall.set(content.call_id, []);
                }
                this.candidateEventsByCall.get(content.call_id).push(event);
            } else {
                call.onRemoteIceCandidatesReceived(event);
            }
            return;
        } else if ([EventType.CallHangup, EventType.CallReject].includes(type)) {
            // Note that we also observe our own hangups here so we can see
            // if we've already rejected a call that would otherwise be valid
            if (!call) {
                // if not live, store the fact that the call has ended because
                // we're probably getting events backwards so
                // the hangup will come before the invite
                call = createNewMatrixCall(
                    this.client,
                    callRoomId,
                    {
                        opponentDeviceId,
                        opponentSessionId: content.sender_session_id,
                    },
                );
                if (call) {
                    call.callId = content.call_id;
                    call.initWithHangup(event);
                    this.calls.set(content.call_id, call);
                }
            } else {
                if (call.state !== CallState.Ended) {
                    if (type === EventType.CallHangup) {
                        call.onHangupReceived(content as MCallHangupReject);
                    } else {
                        call.onRejectReceived(content as MCallHangupReject);
                    }
                    this.calls.delete(content.call_id);
                }
            }
            return;
        }

        // The following events need a call and a peer connection
        if (!call || !call.hasPeerConnection) {
            logger.warn("Discarding an event, we don't have a call/peerConn", type);
            return;
        }
        // Ignore remote echo
        if (event.getContent().party_id === call.ourPartyId) return;

        switch (type) {
            case EventType.CallAnswer:
                if (weSentTheEvent) {
                    if (call.state === CallState.Ringing) {
                        call.onAnsweredElsewhere(content as MCallAnswer);
                    }
                } else {
                    call.onAnswerReceived(event);
                }
                break;
            case EventType.CallSelectAnswer:
                call.onSelectAnswerReceived(event);
                break;

            case EventType.CallNegotiate:
                call.onNegotiateReceived(event);
                break;

            case EventType.CallAssertedIdentity:
            case EventType.CallAssertedIdentityPrefix:
                call.onAssertedIdentityReceived(event);
                break;

            case EventType.CallSDPStreamMetadataChanged:
            case EventType.CallSDPStreamMetadataChangedPrefix:
                call.onSDPStreamMetadataChangedReceived(event);
                break;
        }
    }
}
