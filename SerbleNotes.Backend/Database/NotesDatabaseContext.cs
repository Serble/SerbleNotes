using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database;

public class NotesDatabaseContext(DbContextOptions<NotesDatabaseContext> options) : DbContext(options) {
    public DbSet<NotesUser> Users { get; set; } = null!;
    public DbSet<Vault> Vaults { get; set; } = null!;
    public DbSet<Note> Notes { get; set; } = null!;
    public DbSet<NoteVersion> NoteVersions { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder) {
        modelBuilder.Entity<Vault>()
            .HasIndex(v => v.OwnerId);

        // Both sync queries are "everything in this vault past cursor N", so the cursor belongs in
        // the index next to the owning key.
        modelBuilder.Entity<Note>()
            .HasIndex(n => new { n.VaultId, n.Cursor });

        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => new { v.VaultId, v.Cursor });

        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => v.NoteId);

        modelBuilder.Entity<NoteVersion>()
            .HasIndex(v => v.ParentId);
    }
}
