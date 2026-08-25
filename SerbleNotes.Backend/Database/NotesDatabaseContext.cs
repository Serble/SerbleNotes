using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database;

public class NotesDatabaseContext(DbContextOptions<NotesDatabaseContext> options) : DbContext(options) {
    public DbSet<NotesUser> Users { get; set; } = null!;
    public DbSet<Vault> Vaults { get; set; } = null!;
    public DbSet<VaultKey> VaultKeys { get; set; } = null!;
    public DbSet<Note> Notes { get; set; } = null!;
    public DbSet<NoteVersion> NoteVersions { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder) {
        modelBuilder.Entity<Vault>()
            .HasIndex(v => v.OwnerId);

        // A key row is a membership, so it is read by vault (who can open this) and by user (what
        // can this person open). The composite primary key answers the first and is what stops one
        // person holding two keys to the same vault; the second needs an index of its own, because
        // listing a user's vaults starts from the user.
        modelBuilder.Entity<VaultKey>()
            .HasKey(k => new { k.VaultId, k.UserId });

        modelBuilder.Entity<VaultKey>()
            .HasIndex(k => k.UserId);

        // Both sync queries are "everything in this vault past cursor N", so the cursor belongs in
        // the index next to the owning key.
        modelBuilder.Entity<Note>()
            .HasIndex(n => new { n.VaultId, n.Cursor });

        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => new { v.VaultId, v.Cursor });

        // Ordered by cursor wherever it is read - a note's whole history today, and the tail of it
        // once history can be pruned - so the order is in the index rather than in a filesort.
        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => new { v.NoteId, v.Cursor });

        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => v.ParentId);
    }
}
