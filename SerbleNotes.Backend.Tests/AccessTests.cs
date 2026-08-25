using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services;
using SerbleNotes.Backend.Tests.Support;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// Who may open what.
///
/// This is the boundary the whole product sits on: encryption is the second layer and neither
/// substitutes for the other, so a hole here is a hole. Access is *holding a key row*, not being the
/// owner - which is the same test today and the one that stays right when a vault can be shared.
/// </summary>
public class AccessTests {

    [Fact]
    public async Task A_vault_with_no_key_row_for_this_user_is_not_theirs() {
        World world = new();
        world.GiveVault();

        VaultAccess? access = await world.Access.GetVault(Principal(World.Stranger), "vault-1");

        Assert.Null(access);
    }

    [Fact]
    public async Task Owning_a_vault_without_a_key_row_is_not_enough() {
        World world = new();
        Vault vault = world.GiveVault();

        // The row is what access means. Taking it away must take access away, even from the owner -
        // otherwise "membership is the key row" is a claim the code does not actually make.
        world.Vaults.Keys.Remove((vault.Id, World.Owner));

        Assert.Null(await world.Access.GetVault(Principal(World.Owner), vault.Id));
    }

    [Fact]
    public async Task A_deleted_vault_is_gone_even_for_its_owner() {
        World world = new();
        Vault vault = world.GiveVault();
        vault.DeletedAt = DateTime.UtcNow;

        Assert.Null(await world.Access.GetVault(Principal(World.Owner), vault.Id));
    }

    [Fact]
    public async Task A_vault_that_does_not_exist_and_one_that_is_not_yours_are_indistinguishable() {
        World world = new();
        world.GiveVault();

        // Both null, so both become the same 404. The API must not confirm that someone else's id
        // exists - that is an oracle for guessing at ids.
        Assert.Null(await world.Access.GetVault(Principal(World.Stranger), "vault-1"));
        Assert.Null(await world.Access.GetVault(Principal(World.Stranger), "no-such-vault"));
    }

    [Fact]
    public async Task Access_carries_the_callers_own_key_and_says_whether_they_own_it() {
        World world = new();
        Vault vault = world.GiveVault();

        // A second holder, which nothing in the app can make yet - but the shape must already be
        // right, because this is the check that will decide what a shared vault can do.
        world.Vaults.Keys[(vault.Id, World.Stranger)] = new VaultKey {
            VaultId = vault.Id,
            UserId = World.Stranger,
            WrappedKey = "wrapped-for-stranger",
            CreatedAt = DateTime.UtcNow,
            VaultNavigation = vault
        };

        VaultAccess owner = (await world.Access.GetVault(Principal(World.Owner), vault.Id))!;
        VaultAccess guest = (await world.Access.GetVault(Principal(World.Stranger), vault.Id))!;

        Assert.True(owner.IsOwner);
        Assert.False(guest.IsOwner);
        Assert.Equal("wrapped-for-owner-user", owner.Key.WrappedKey);
        Assert.Equal("wrapped-for-stranger", guest.Key.WrappedKey);
    }

    [Fact]
    public async Task A_note_is_reachable_only_through_its_own_vault() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        Assert.NotNull(await world.Access.GetNote(Principal(World.Owner), "note-1"));
        Assert.Null(await world.Access.GetNote(Principal(World.Stranger), "note-1"));
    }

    [Fact]
    public async Task A_stranger_reading_someone_elses_note_gets_a_404_not_a_403() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<Note> result = await world.NotesController(World.Stranger).GetNote("note-1");

        Assert.Equal(404, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task A_stranger_cannot_read_a_notes_versions() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<IEnumerable<NoteVersion>> result =
            await world.NotesController(World.Stranger).GetVersions("note-1");

        Assert.Equal(404, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task A_stranger_cannot_delete_or_rename_a_note() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        Assert.Equal(404, World.StatusOf(await world.NotesController(World.Stranger).DeleteNote("note-1")));
        Assert.Equal(404, World.StatusOf(
            (await world.NotesController(World.Stranger).RenameNote("note-1", new RenameNoteRequest { Name = "eA==" }))
                .Result!));

        Assert.Null(world.Notes.Notes["note-1"].DeletedAt);
        Assert.Equal("c2VhbGVk", world.Notes.Notes["note-1"].Name);
    }

    [Fact]
    public async Task Only_the_owner_can_delete_a_vault() {
        World world = new();
        Vault vault = world.GiveVault();
        world.Vaults.Keys[(vault.Id, World.Stranger)] = new VaultKey {
            VaultId = vault.Id, UserId = World.Stranger, WrappedKey = "k", CreatedAt = DateTime.UtcNow,
            VaultNavigation = vault
        };

        // Holding a key is enough to read the vault and not enough to destroy it.
        Assert.Equal(403, World.StatusOf(await world.VaultsController(World.Stranger).DeleteVault(vault.Id)));
        Assert.Null(vault.DeletedAt);

        Assert.Equal(204, World.StatusOf(await world.VaultsController(World.Owner).DeleteVault(vault.Id)));
        Assert.NotNull(vault.DeletedAt);
    }

    private static System.Security.Claims.ClaimsPrincipal Principal(string userId) {
        return new System.Security.Claims.ClaimsPrincipal(
            new System.Security.Claims.ClaimsIdentity(
                [new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, userId)], "test"));
    }
}
