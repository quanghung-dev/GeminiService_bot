BEGIN;

CREATE TABLE "AdminAccount" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,

    CONSTRAINT "AdminAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminAccount_singleton" CHECK ("id" = 1)
);

CREATE UNIQUE INDEX "AdminAccount_username_key" ON "AdminAccount"("username");

COMMIT;
