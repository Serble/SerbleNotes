using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services.Impl;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// The sync fan-out: what goes out over a socket, and to which of a user's devices.
///
/// Presence is the delicate half. Vaults are single-owner, so it says "you have this open somewhere
/// else" and never "somebody else is here" - a device that saw its own reflection in that list would
/// be inventing a second person out of a phone left on the sofa.
/// </summary>
public class SyncTests {

    /// <summary>A socket that keeps what was written to it, and can be told to be closed or to fail.</summary>
    private sealed class FakeSocket : WebSocket {
        public readonly List<string> Frames = [];

        /// <summary>Whether each frame was sent as a complete message rather than a fragment.</summary>
        public readonly List<bool> Complete = [];

        public bool Broken;
        private WebSocketState _state = WebSocketState.Open;

        public void Close() => _state = WebSocketState.Closed;

        public override WebSocketState State => _state;

        public override Task SendAsync(
            ArraySegment<byte> buffer, WebSocketMessageType type, bool end, CancellationToken token) {
            if (Broken) {
                throw new WebSocketException("gone");
            }
            Frames.Add(Encoding.UTF8.GetString(buffer.Array!, buffer.Offset, buffer.Count));
            Complete.Add(end);
            return Task.CompletedTask;
        }

        public T Last<T>() => JsonSerializer.Deserialize<T>(
            Frames[^1], new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus s, string? d, CancellationToken t) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus s, string? d, CancellationToken t) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> b, CancellationToken t) =>
            throw new NotSupportedException();
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override string? SubProtocol => null;
    }

    private static SyncConnectionManager NewManager() {
        return new SyncConnectionManager(NullLogger<SyncConnectionManager>.Instance);
    }

    private static SyncVersion Version(int payloadBytes) {
        return new SyncVersion {
            Id = "v1", NoteId = "n1", VaultId = "vault-1", IsSnapshot = true,
            Payload = new byte[payloadBytes], Size = payloadBytes, Cursor = 1
        };
    }

    // --- presence ---------------------------------------------------------------------------

    [Fact]
    public async Task A_device_is_never_shown_its_own_reflection() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        Guid id = manager.Add("user", phone, "phone");

        await manager.Watch("user", id, "vault-1", "note-1");

        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task Each_device_hears_about_the_others() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        Guid laptopId = manager.Add("user", laptop, "laptop");

        await manager.Watch("user", phoneId, "vault-1", "note-1");
        await manager.Watch("user", laptopId, "vault-1", "note-2");

        // The kind is how the client knows which of the three shapes this frame is; a frame it
        // cannot classify is one it drops, and presence would silently stop working.
        Assert.Equal("presence", phone.Last<SyncEvent>().Kind);
        Assert.Equal("laptop", Assert.Single(phone.Last<SyncEvent>().Present).DeviceId);
        Assert.Equal("phone", Assert.Single(laptop.Last<SyncEvent>().Present).DeviceId);
    }

    [Fact]
    public async Task A_device_that_is_in_no_vault_is_not_present_anywhere() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket idle = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        manager.Add("user", idle, "idle");

        await manager.Watch("user", phoneId, "vault-1", "note-1");

        // Connected but looking at nothing - a signed-in tab on the vault list is not "open
        // elsewhere", and saying so would put a mark on a note nobody has open.
        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task Leaving_a_vault_clears_the_mark_on_the_other_device() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        Guid laptopId = manager.Add("user", laptop, "laptop");

        await manager.Watch("user", phoneId, "vault-1", "note-1");
        await manager.Watch("user", laptopId, "vault-1", "note-1");
        Assert.Single(phone.Last<SyncEvent>().Present);

        await manager.Watch("user", laptopId, null, null);

        // The empty list is the message that clears a stale "open elsewhere".
        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task A_disconnected_device_stops_being_present() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        Guid laptopId = manager.Add("user", laptop, "laptop");
        await manager.Watch("user", phoneId, "vault-1", "note-1");
        await manager.Watch("user", laptopId, "vault-1", "note-1");

        manager.Remove("user", laptopId);
        await manager.BroadcastPresence("user");

        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task Another_users_devices_are_not_in_the_list_at_all() {
        SyncConnectionManager manager = NewManager();
        FakeSocket mine = new();
        FakeSocket theirs = new();
        Guid mineId = manager.Add("user", mine, "mine");
        Guid theirsId = manager.Add("other-user", theirs, "theirs");

        await manager.Watch("other-user", theirsId, "vault-1", "note-1");
        await manager.Watch("user", mineId, "vault-1", "note-1");

        Assert.Empty(mine.Last<SyncEvent>().Present);
        Assert.Empty(theirs.Last<SyncEvent>().Present);
    }

    // --- delivery ---------------------------------------------------------------------------

    [Fact]
    public async Task A_change_reaches_every_one_of_that_users_sockets_and_no_one_elses() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        FakeSocket stranger = new();
        manager.Add("user", phone, "phone");
        manager.Add("user", laptop, "laptop");
        manager.Add("other-user", stranger, "stranger");

        await manager.SendToUser("user", new SyncEvent { Kind = "change", VaultId = "vault-1" });

        Assert.Single(phone.Frames);
        Assert.Single(laptop.Frames);
        Assert.Empty(stranger.Frames);
    }

    [Fact]
    public async Task A_pong_goes_only_to_the_socket_that_asked() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        manager.Add("user", laptop, "laptop");

        await manager.SendToConnection("user", phoneId, new SyncEvent { Kind = "pong" });

        Assert.Single(phone.Frames);
        Assert.Empty(laptop.Frames);
    }

    [Fact]
    public async Task A_socket_that_has_closed_is_dropped_rather_than_written_to() {
        SyncConnectionManager manager = NewManager();
        FakeSocket dead = new();
        FakeSocket live = new();
        manager.Add("user", dead, "dead");
        manager.Add("user", live, "live");
        dead.Close();

        await manager.SendToUser("user", new SyncEvent { Kind = "change" });

        Assert.Empty(dead.Frames);
        Assert.Single(live.Frames);
    }

    [Fact]
    public async Task A_socket_that_throws_mid_send_does_not_break_the_delivery_to_the_others() {
        SyncConnectionManager manager = NewManager();
        FakeSocket broken = new() { Broken = true };
        FakeSocket live = new();
        manager.Add("user", broken, "broken");
        manager.Add("user", live, "live");

        // The write that triggered this is already committed. A dead socket must never turn a
        // successful save into an error, and the client catches up from its cursor anyway.
        await manager.SendToUser("user", new SyncEvent { Kind = "change" });

        Assert.Single(live.Frames);
    }

    [Fact]
    public async Task A_socket_that_closed_stops_being_present_as_well_as_stopping_receiving() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        Guid laptopId = manager.Add("user", laptop, "laptop");
        await manager.Watch("user", phoneId, "vault-1", "note-1");
        await manager.Watch("user", laptopId, "vault-1", "note-1");

        laptop.Close();
        await manager.BroadcastPresence("user");

        // Skipping the send is not enough: a connection left in the table goes on telling the phone
        // that the note is open elsewhere, and nothing will ever clear it.
        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task A_socket_that_throws_stops_being_present_too() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        FakeSocket laptop = new();
        Guid phoneId = manager.Add("user", phone, "phone");
        Guid laptopId = manager.Add("user", laptop, "laptop");
        await manager.Watch("user", phoneId, "vault-1", "note-1");
        await manager.Watch("user", laptopId, "vault-1", "note-1");

        laptop.Broken = true;
        await manager.BroadcastPresence("user");
        await manager.BroadcastPresence("user");

        Assert.Empty(phone.Last<SyncEvent>().Present);
    }

    [Fact]
    public async Task Every_frame_is_sent_as_a_complete_message() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        manager.Add("user", phone, "phone");

        await manager.SendToUser("user", new SyncEvent { Kind = "change", VaultId = "vault-1" });

        // A frame marked as a fragment is one the client never finishes reading, so the socket goes
        // quiet with no error either end can report - the exact failure the ping loop exists for.
        Assert.True(Assert.Single(phone.Complete));
    }

    [Fact]
    public async Task Notifying_a_user_with_no_sockets_is_not_an_error() {
        SyncConnectionManager manager = NewManager();
        await manager.SendToUser("nobody", new SyncEvent { Kind = "change" });
    }

    [Fact]
    public async Task The_event_goes_out_camel_cased_the_way_the_client_reads_it() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        manager.Add("user", phone, "phone");

        await manager.SendToUser("user", new SyncEvent { Kind = "change", VaultId = "vault-1", Cursor = 7 });

        Assert.Contains("\"vaultId\"", phone.Frames[0]);
        Assert.DoesNotContain("\"VaultId\"", phone.Frames[0]);
    }

    // --- what is pushed ---------------------------------------------------------------------

    [Fact]
    public async Task A_small_payload_travels_with_the_notification() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        manager.Add("user", phone, "phone");
        InProcessSyncNotifier notifier = new(manager);

        await notifier.NotifyVaultChanged("user", "vault-1", 3, null, [], [Version(1024)]);

        // The point of carrying rows: the other device shows the edit without a round trip.
        Assert.Equal("change", phone.Last<SyncEvent>().Kind);
        Assert.NotNull(Assert.Single(phone.Last<SyncEvent>().Versions).Payload);
    }

    [Fact]
    public async Task A_payload_too_big_to_push_is_sent_as_metadata_with_its_size_intact() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        manager.Add("user", phone, "phone");
        InProcessSyncNotifier notifier = new(manager);

        await notifier.NotifyVaultChanged("user", "vault-1", 3, null, [], [Version(256 * 1024 + 1)]);

        SyncVersion pushed = Assert.Single(phone.Last<SyncEvent>().Versions);
        Assert.Null(pushed.Payload);
        Assert.Equal(256 * 1024 + 1, pushed.Size);
        Assert.True(pushed.IsSnapshot, "the client still needs the shape to know what to fetch");
    }

    [Fact]
    public async Task Exactly_at_the_push_limit_still_travels() {
        SyncConnectionManager manager = NewManager();
        FakeSocket phone = new();
        manager.Add("user", phone, "phone");
        InProcessSyncNotifier notifier = new(manager);

        await notifier.NotifyVaultChanged("user", "vault-1", 3, null, [], [Version(256 * 1024)]);

        Assert.NotNull(Assert.Single(phone.Last<SyncEvent>().Versions).Payload);
    }

    [Fact]
    public async Task Trimming_a_payload_does_not_empty_the_row_the_caller_handed_over() {
        SyncConnectionManager manager = NewManager();
        manager.Add("user", new FakeSocket(), "phone");
        InProcessSyncNotifier notifier = new(manager);

        SyncVersion original = Version(256 * 1024 + 1);
        await notifier.NotifyVaultChanged("user", "vault-1", 3, null, [], [original]);

        // The instance passed in may be the one just written to the database. Trimming in place
        // would blank the ciphertext of a version that had only just been stored.
        Assert.NotNull(original.Payload);
    }
}
