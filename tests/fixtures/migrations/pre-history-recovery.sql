-- Synthetic populated accepted-27 baseline; no customer data or provider work.
INSERT INTO "ProductUser"(id) VALUES('pre32-user');
INSERT INTO "Workspace"(id,name) VALUES('pre32-workspace','Synthetic recovery baseline');
INSERT INTO "Site"(id,"workspaceId",origin) VALUES('pre32-site','pre32-workspace','https://recovery-fixture.example');
INSERT INTO "ContentDraft"(id,"workspaceId","siteId",kind,revision,snapshot) VALUES('pre32-draft','pre32-workspace','pre32-site','draft',3,'{}');
INSERT INTO "ContentRevision"(id,"workspaceId","draftId",revision,content,"userId","createdAt") VALUES
 ('pre32-old','pre32-workspace','pre32-draft',1,'{"title":"Older","body":"OLD_SYNTHETIC_BODY","assumptions":[],"citations":[]}','pre32-user','2024-01-31T12:45:56.789Z'),
 ('pre32-pin','pre32-workspace','pre32-draft',2,'{"title":"Pinned","body":"PIN_SYNTHETIC_BODY","assumptions":[],"citations":[]}','pre32-user','2024-01-31T12:45:56.789Z'),
 ('pre32-head','pre32-workspace','pre32-draft',3,'{"title":"Head","body":"HEAD_SYNTHETIC_BODY","assumptions":[],"citations":[]}','pre32-user','2024-01-31T12:45:56.789Z');
INSERT INTO "ContentRevisionPin"("workspaceId","draftId",revision,"pinnedBy") VALUES('pre32-workspace','pre32-draft',2,'pre32-user');
