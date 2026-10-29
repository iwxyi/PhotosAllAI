import { z } from 'zod';
import type { AgentSession, McpStatus } from './agent';
import type { FileWorkflowConfig, FileWorkflowScope } from './file-workflow';
export * from './file-workflow';
export declare const appInfoSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    platform: z.ZodEnum<{
        darwin: "darwin";
        win32: "win32";
        linux: "linux";
    }>;
}, z.core.$strip>;
export type AppInfo = z.infer<typeof appInfoSchema>;
export declare const libraryIntegrityReportSchema: z.ZodObject<{
    status: z.ZodEnum<{
        error: "error";
        healthy: "healthy";
        warning: "warning";
    }>;
    databaseStatus: z.ZodEnum<{
        ok: "ok";
        corrupt: "corrupt";
        unreadable: "unreadable";
    }>;
    activeGenerationResults: z.ZodNumber;
    trashedGenerationResults: z.ZodNumber;
    pendingGenerationWrites: z.ZodNumber;
    staleGenerationWriteIntents: z.ZodNumber;
    unsafeGenerationWriteIntents: z.ZodNumber;
    missingActiveFiles: z.ZodNumber;
    missingTrashFiles: z.ZodNumber;
    unsafeManagedPaths: z.ZodNumber;
    unsafeTrashPaths: z.ZodNumber;
    nonRegularFiles: z.ZodNumber;
    inaccessibleFiles: z.ZodNumber;
    unexpectedGeneratedFiles: z.ZodNumber;
    unexpectedTrashFiles: z.ZodNumber;
    checkedAt: z.ZodNumber;
}, z.core.$strip>;
export type LibraryIntegrityReport = z.infer<typeof libraryIntegrityReportSchema>;
export declare const diagnosticSnapshotSchema: z.ZodObject<{
    appVersion: z.ZodString;
    platform: z.ZodEnum<{
        darwin: "darwin";
        win32: "win32";
        linux: "linux";
    }>;
    catalog: z.ZodObject<{
        assets: z.ZodNumber;
        offline: z.ZodNumber;
    }, z.core.$strip>;
    catalogWatcher: z.ZodObject<{
        watchedFolders: z.ZodNumber;
        activeWatchers: z.ZodNumber;
        watchFailures: z.ZodNumber;
        reconciliationFailures: z.ZodNumber;
    }, z.core.$strip>;
    providers: z.ZodObject<{
        total: z.ZodNumber;
        enabled: z.ZodNumber;
    }, z.core.$strip>;
    tasks: z.ZodRecord<z.ZodString, z.ZodNumber>;
    cache: z.ZodObject<{
        files: z.ZodNumber;
        bytes: z.ZodNumber;
        performance: z.ZodObject<{
            hits: z.ZodNumber;
            misses: z.ZodNumber;
            decodes: z.ZodNumber;
            decodeMsTotal: z.ZodNumber;
        }, z.core.$strip>;
        raw: z.ZodObject<{
            nativeImage: z.ZodBoolean;
            imageMagick: z.ZodBoolean;
            sips: z.ZodBoolean;
        }, z.core.$strip>;
    }, z.core.$strip>;
    startupRecovery: z.ZodObject<{
        trashPurges: z.ZodObject<{
            total: z.ZodNumber;
            recovered: z.ZodNumber;
            conflicts: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        fileOperations: z.ZodObject<{
            total: z.ZodNumber;
            resolved: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        generationWrites: z.ZodObject<{
            total: z.ZodNumber;
            recovered: z.ZodNumber;
            failed: z.ZodNumber;
        }, z.core.$strip>;
        automaticBackup: z.ZodObject<{
            status: z.ZodEnum<{
                completed: "completed";
                failed: "failed";
                pending: "pending";
                skipped: "skipped";
            }>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    integrity: z.ZodObject<{
        status: z.ZodEnum<{
            error: "error";
            healthy: "healthy";
            warning: "warning";
        }>;
        databaseStatus: z.ZodEnum<{
            ok: "ok";
            corrupt: "corrupt";
            unreadable: "unreadable";
        }>;
        activeGenerationResults: z.ZodNumber;
        trashedGenerationResults: z.ZodNumber;
        pendingGenerationWrites: z.ZodNumber;
        staleGenerationWriteIntents: z.ZodNumber;
        unsafeGenerationWriteIntents: z.ZodNumber;
        missingActiveFiles: z.ZodNumber;
        missingTrashFiles: z.ZodNumber;
        unsafeManagedPaths: z.ZodNumber;
        unsafeTrashPaths: z.ZodNumber;
        nonRegularFiles: z.ZodNumber;
        inaccessibleFiles: z.ZodNumber;
        unexpectedGeneratedFiles: z.ZodNumber;
        unexpectedTrashFiles: z.ZodNumber;
        checkedAt: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;
export declare const diagnosticExportResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    bytes: z.ZodNumber;
    sha256: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type DiagnosticExportResult = z.infer<typeof diagnosticExportResultSchema>;
export declare const databaseBackupResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    destinationPath: z.ZodNullable<z.ZodString>;
    bytes: z.ZodNumber;
    sha256: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type DatabaseBackupResult = z.infer<typeof databaseBackupResultSchema>;
export declare const libraryBackupResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    databaseBytes: z.ZodNumber;
    generatedFiles: z.ZodNumber;
    generatedBytes: z.ZodNumber;
    manifestSha256: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type LibraryBackupResult = z.infer<typeof libraryBackupResultSchema>;
export declare const libraryBackupVerificationResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    createdAt: z.ZodNullable<z.ZodString>;
    databaseBytes: z.ZodNumber;
    generatedFiles: z.ZodNumber;
    generatedBytes: z.ZodNumber;
}, z.core.$strip>;
export type LibraryBackupVerificationResult = z.infer<typeof libraryBackupVerificationResultSchema>;
export declare const libraryRestoreResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    createdAt: z.ZodNullable<z.ZodString>;
    databaseBytes: z.ZodNumber;
    generatedFiles: z.ZodNumber;
    generatedBytes: z.ZodNumber;
}, z.core.$strip>;
export type LibraryRestoreResult = z.infer<typeof libraryRestoreResultSchema>;
export declare const appSettingsSchema: z.ZodObject<{
    generationStorageMode: z.ZodDefault<z.ZodEnum<{
        managed: "managed";
        portable: "portable";
    }>>;
    theme: z.ZodDefault<z.ZodEnum<{
        system: "system";
        dark: "dark";
        light: "light";
    }>>;
    locale: z.ZodDefault<z.ZodEnum<{
        "zh-CN": "zh-CN";
        "en-US": "en-US";
    }>>;
    cacheMaxBytes: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export declare const workspaceTabSchema: z.ZodUnion<readonly [z.ZodEnum<{
    tasks: "tasks";
    library: "library";
    viewer: "viewer";
    batch: "batch";
    workflow: "workflow";
    templates: "templates";
    settings: "settings";
}>, z.ZodTemplateLiteral<`task:${string}`>]>;
export type WorkspaceTab = z.infer<typeof workspaceTabSchema>;
export declare const workspaceSessionV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    openTabs: z.ZodArray<z.ZodUnion<readonly [z.ZodEnum<{
        tasks: "tasks";
        library: "library";
        viewer: "viewer";
        batch: "batch";
        workflow: "workflow";
        templates: "templates";
        settings: "settings";
    }>, z.ZodTemplateLiteral<`task:${string}`>]>>;
    activeTab: z.ZodUnion<readonly [z.ZodEnum<{
        tasks: "tasks";
        library: "library";
        viewer: "viewer";
        batch: "batch";
        workflow: "workflow";
        templates: "templates";
        settings: "settings";
    }>, z.ZodTemplateLiteral<`task:${string}`>]>;
    library: z.ZodObject<{
        selectedFolderId: z.ZodNullable<z.ZodString>;
        selectedTagId: z.ZodNullable<z.ZodString>;
        selectedAssetId: z.ZodNullable<z.ZodString>;
        searchQuery: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type WorkspaceSessionV1 = z.infer<typeof workspaceSessionV1Schema>;
export declare const workspaceSessionSchema: z.ZodObject<{
    version: z.ZodLiteral<2>;
    openTabs: z.ZodArray<z.ZodUnion<readonly [z.ZodEnum<{
        tasks: "tasks";
        library: "library";
        viewer: "viewer";
        batch: "batch";
        workflow: "workflow";
        templates: "templates";
        settings: "settings";
    }>, z.ZodTemplateLiteral<`task:${string}`>]>>;
    activeTab: z.ZodUnion<readonly [z.ZodEnum<{
        tasks: "tasks";
        library: "library";
        viewer: "viewer";
        batch: "batch";
        workflow: "workflow";
        templates: "templates";
        settings: "settings";
    }>, z.ZodTemplateLiteral<`task:${string}`>]>;
    library: z.ZodObject<{
        selectedFolderId: z.ZodNullable<z.ZodString>;
        selectedAlbumId: z.ZodNullable<z.ZodString>;
        selectedSmartCollection: z.ZodNullable<z.ZodEnum<{
            recent: "recent";
            favorites: "favorites";
            unrated: "unrated";
            unanalyzed: "unanalyzed";
            generated: "generated";
            "to-review": "to-review";
        }>>;
        selectedTagId: z.ZodNullable<z.ZodString>;
        selectedAssetId: z.ZodNullable<z.ZodString>;
        favoriteOnly: z.ZodBoolean;
        sortBy: z.ZodEnum<{
            modifiedAt: "modifiedAt";
            fileName: "fileName";
            rating: "rating";
        }>;
        sortDirection: z.ZodOptional<z.ZodEnum<{
            asc: "asc";
            desc: "desc";
        }>>;
        searchQuery: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;
export declare const menuCommandSchema: z.ZodEnum<{
    "open-library": "open-library";
    "open-viewer": "open-viewer";
    "open-batch": "open-batch";
    "open-workflow": "open-workflow";
    "open-templates": "open-templates";
    "open-tasks": "open-tasks";
    "open-settings": "open-settings";
    "import-folders": "import-folders";
    "refresh-catalog": "refresh-catalog";
    "select-all": "select-all";
    "clear-selection": "clear-selection";
    "analyze-selection": "analyze-selection";
    "generate-selection": "generate-selection";
    "open-task-center": "open-task-center";
    "open-prompt-templates": "open-prompt-templates";
    "toggle-original": "toggle-original";
    "fit-image": "fit-image";
    "zoom-100": "zoom-100";
    "close-workspace": "close-workspace";
    "show-shortcuts": "show-shortcuts";
}>;
export type MenuCommand = z.infer<typeof menuCommandSchema>;
export declare const menuStateSchema: z.ZodObject<{
    activeTab: z.ZodUnion<readonly [z.ZodEnum<{
        tasks: "tasks";
        library: "library";
        viewer: "viewer";
        batch: "batch";
        workflow: "workflow";
        templates: "templates";
        settings: "settings";
    }>, z.ZodTemplateLiteral<`task:${string}`>]>;
    hasSelection: z.ZodBoolean;
    selectionCount: z.ZodNumber;
    hasVisionProvider: z.ZodBoolean;
    hasGenerationProvider: z.ZodBoolean;
    taskCount: z.ZodNumber;
    hasRunningTask: z.ZodBoolean;
}, z.core.$strip>;
export type MenuState = z.infer<typeof menuStateSchema>;
export declare const openPathResultSchema: z.ZodObject<{
    canceled: z.ZodBoolean;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type OpenPathResult = z.infer<typeof openPathResultSchema>;
export declare const catalogTagSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    assetCount: z.ZodNumber;
}, z.core.$strip>;
export type CatalogTag = z.infer<typeof catalogTagSchema>;
export declare const deleteCatalogTagInputSchema: z.ZodString;
export type DeleteCatalogTagInput = z.input<typeof deleteCatalogTagInputSchema>;
export declare const fileWorkflowGroupSchema: z.ZodObject<{
    id: z.ZodString;
    key: z.ZodString;
    name: z.ZodString;
    stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>>>;
    members: z.ZodArray<z.ZodObject<{
        stageId: z.ZodString;
        stageName: z.ZodString;
        variant: z.ZodString;
        asset: z.ZodObject<{
            id: z.ZodString;
            folderId: z.ZodString;
            directoryId: z.ZodOptional<z.ZodString>;
            relativePath: z.ZodOptional<z.ZodString>;
            fileName: z.ZodString;
            format: z.ZodString;
            sizeBytes: z.ZodNumber;
            modifiedAt: z.ZodNumber;
            rating: z.ZodNumber;
            labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                red: "red";
                yellow: "yellow";
                green: "green";
                blue: "blue";
                purple: "purple";
            }>>>;
            flag: z.ZodDefault<z.ZodEnum<{
                rejected: "rejected";
                picked: "picked";
                unflagged: "unflagged";
            }>>;
            favorite: z.ZodBoolean;
            offline: z.ZodBoolean;
            tags: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>>;
            thumbnailUrl: z.ZodString;
            previewUrl: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type FileWorkflowGroup = z.infer<typeof fileWorkflowGroupSchema>;
export declare const fileWorkflowStatusSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    matched: z.ZodNumber;
    unmatched: z.ZodNumber;
    conflicts: z.ZodNumber;
}, z.core.$strip>;
export declare const catalogAssetSchema: z.ZodObject<{
    id: z.ZodString;
    folderId: z.ZodString;
    directoryId: z.ZodOptional<z.ZodString>;
    relativePath: z.ZodOptional<z.ZodString>;
    fileName: z.ZodString;
    format: z.ZodString;
    sizeBytes: z.ZodNumber;
    modifiedAt: z.ZodNumber;
    rating: z.ZodNumber;
    labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
        red: "red";
        yellow: "yellow";
        green: "green";
        blue: "blue";
        purple: "purple";
    }>>>;
    flag: z.ZodDefault<z.ZodEnum<{
        rejected: "rejected";
        picked: "picked";
        unflagged: "unflagged";
    }>>;
    favorite: z.ZodBoolean;
    offline: z.ZodBoolean;
    tags: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>>;
    thumbnailUrl: z.ZodString;
    previewUrl: z.ZodString;
    workflow: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        key: z.ZodString;
        name: z.ZodString;
        stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>>>;
        members: z.ZodArray<z.ZodObject<{
            stageId: z.ZodString;
            stageName: z.ZodString;
            variant: z.ZodString;
            asset: z.ZodObject<{
                id: z.ZodString;
                folderId: z.ZodString;
                directoryId: z.ZodOptional<z.ZodString>;
                fileName: z.ZodString;
                format: z.ZodString;
                sizeBytes: z.ZodNumber;
                modifiedAt: z.ZodNumber;
                rating: z.ZodNumber;
                labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                    red: "red";
                    yellow: "yellow";
                    green: "green";
                    blue: "blue";
                    purple: "purple";
                }>>>;
                flag: z.ZodDefault<z.ZodEnum<{
                    rejected: "rejected";
                    picked: "picked";
                    unflagged: "unflagged";
                }>>;
                favorite: z.ZodBoolean;
                offline: z.ZodBoolean;
                tags: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    name: z.ZodString;
                }, z.core.$strip>>;
                thumbnailUrl: z.ZodString;
                previewUrl: z.ZodString;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    workflowConflict: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type CatalogAsset = z.infer<typeof catalogAssetSchema>;
export declare const fileDetailsSchema: z.ZodObject<{
    path: z.ZodString;
    sizeBytes: z.ZodNumber;
    modifiedAt: z.ZodNumber;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    camera: z.ZodOptional<z.ZodString>;
    lens: z.ZodOptional<z.ZodString>;
    takenAt: z.ZodOptional<z.ZodString>;
    cameraMake: z.ZodOptional<z.ZodString>;
    cameraModel: z.ZodOptional<z.ZodString>;
    lensMake: z.ZodOptional<z.ZodString>;
    lensModel: z.ZodOptional<z.ZodString>;
    city: z.ZodOptional<z.ZodString>;
    country: z.ZodOptional<z.ZodString>;
    exposure: z.ZodOptional<z.ZodString>;
    aperture: z.ZodOptional<z.ZodNumber>;
    exposureSeconds: z.ZodOptional<z.ZodNumber>;
    iso: z.ZodOptional<z.ZodNumber>;
    focalLength: z.ZodOptional<z.ZodNumber>;
    metadataWarning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type FileDetails = z.infer<typeof fileDetailsSchema>;
export declare const quickViewSessionSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        folderId: z.ZodString;
        directoryId: z.ZodOptional<z.ZodString>;
        fileName: z.ZodString;
        format: z.ZodString;
        sizeBytes: z.ZodNumber;
        modifiedAt: z.ZodNumber;
        rating: z.ZodNumber;
        labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
            red: "red";
            yellow: "yellow";
            green: "green";
            blue: "blue";
            purple: "purple";
        }>>>;
        flag: z.ZodDefault<z.ZodEnum<{
            rejected: "rejected";
            picked: "picked";
            unflagged: "unflagged";
        }>>;
        favorite: z.ZodBoolean;
        offline: z.ZodBoolean;
        tags: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>>;
        thumbnailUrl: z.ZodString;
        previewUrl: z.ZodString;
        workflow: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            key: z.ZodString;
            name: z.ZodString;
            stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>>>;
            members: z.ZodArray<z.ZodObject<{
                stageId: z.ZodString;
                stageName: z.ZodString;
                variant: z.ZodString;
                asset: z.ZodObject<{
                    id: z.ZodString;
                    folderId: z.ZodString;
                    directoryId: z.ZodOptional<z.ZodString>;
                    fileName: z.ZodString;
                    format: z.ZodString;
                    sizeBytes: z.ZodNumber;
                    modifiedAt: z.ZodNumber;
                    rating: z.ZodNumber;
                    labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                        red: "red";
                        yellow: "yellow";
                        green: "green";
                        blue: "blue";
                        purple: "purple";
                    }>>>;
                    flag: z.ZodDefault<z.ZodEnum<{
                        rejected: "rejected";
                        picked: "picked";
                        unflagged: "unflagged";
                    }>>;
                    favorite: z.ZodBoolean;
                    offline: z.ZodBoolean;
                    tags: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        name: z.ZodString;
                    }, z.core.$strip>>;
                    thumbnailUrl: z.ZodString;
                    previewUrl: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        workflowConflict: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    selectedId: z.ZodString;
    directory: z.ZodString;
}, z.core.$strip>;
export type QuickViewSession = z.infer<typeof quickViewSessionSchema>;
export declare const catalogAssetCursorSchema: z.ZodObject<{
    modifiedAt: z.ZodNumber;
    id: z.ZodString;
    sortValue: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
}, z.core.$strip>;
export type CatalogAssetCursor = z.infer<typeof catalogAssetCursorSchema>;
export declare const listCatalogAssetsInputSchema: z.ZodObject<{
    assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    folderId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tagId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    albumId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    smartCollection: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
        recent: "recent";
        favorites: "favorites";
        unrated: "unrated";
        unanalyzed: "unanalyzed";
        generated: "generated";
        "to-review": "to-review";
    }>>>;
    favoriteOnly: z.ZodDefault<z.ZodBoolean>;
    folderIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    dateFrom: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    dateTo: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    months: z.ZodDefault<z.ZodArray<z.ZodString>>;
    formats: z.ZodDefault<z.ZodArray<z.ZodString>>;
    minimumRating: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    ratingOperator: z.ZodDefault<z.ZodEnum<{
        eq: "eq";
        gte: "gte";
        lte: "lte";
    }>>;
    flags: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        rejected: "rejected";
        picked: "picked";
        unflagged: "unflagged";
    }>>>;
    colors: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        red: "red";
        yellow: "yellow";
        green: "green";
        blue: "blue";
        purple: "purple";
    }>>>;
    sortBy: z.ZodDefault<z.ZodEnum<{
        modifiedAt: "modifiedAt";
        fileName: "fileName";
        rating: "rating";
    }>>;
    sortDirection: z.ZodOptional<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
    query: z.ZodDefault<z.ZodString>;
    workflow: z.ZodDefault<z.ZodBoolean>;
    cursor: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        modifiedAt: z.ZodNumber;
        id: z.ZodString;
        sortValue: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    }, z.core.$strip>>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ListCatalogAssetsInput = z.input<typeof listCatalogAssetsInputSchema>;
export declare const catalogAssetPageSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        folderId: z.ZodString;
        directoryId: z.ZodOptional<z.ZodString>;
        fileName: z.ZodString;
        format: z.ZodString;
        sizeBytes: z.ZodNumber;
        modifiedAt: z.ZodNumber;
        rating: z.ZodNumber;
        labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
            red: "red";
            yellow: "yellow";
            green: "green";
            blue: "blue";
            purple: "purple";
        }>>>;
        flag: z.ZodDefault<z.ZodEnum<{
            rejected: "rejected";
            picked: "picked";
            unflagged: "unflagged";
        }>>;
        favorite: z.ZodBoolean;
        offline: z.ZodBoolean;
        tags: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>>;
        thumbnailUrl: z.ZodString;
        previewUrl: z.ZodString;
        workflow: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            key: z.ZodString;
            name: z.ZodString;
            stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>>>;
            members: z.ZodArray<z.ZodObject<{
                stageId: z.ZodString;
                stageName: z.ZodString;
                variant: z.ZodString;
                asset: z.ZodObject<{
                    id: z.ZodString;
                    folderId: z.ZodString;
                    directoryId: z.ZodOptional<z.ZodString>;
                    fileName: z.ZodString;
                    format: z.ZodString;
                    sizeBytes: z.ZodNumber;
                    modifiedAt: z.ZodNumber;
                    rating: z.ZodNumber;
                    labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                        red: "red";
                        yellow: "yellow";
                        green: "green";
                        blue: "blue";
                        purple: "purple";
                    }>>>;
                    flag: z.ZodDefault<z.ZodEnum<{
                        rejected: "rejected";
                        picked: "picked";
                        unflagged: "unflagged";
                    }>>;
                    favorite: z.ZodBoolean;
                    offline: z.ZodBoolean;
                    tags: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        name: z.ZodString;
                    }, z.core.$strip>>;
                    thumbnailUrl: z.ZodString;
                    previewUrl: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        workflowConflict: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    totalCount: z.ZodNumber;
    nextCursor: z.ZodNullable<z.ZodObject<{
        modifiedAt: z.ZodNumber;
        id: z.ZodString;
        sortValue: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    }, z.core.$strip>>;
    workflowStatus: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        matched: z.ZodNumber;
        unmatched: z.ZodNumber;
        conflicts: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CatalogAssetPage = z.infer<typeof catalogAssetPageSchema>;
export declare const catalogFolderSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    assetCount: z.ZodNumber;
    offlineCount: z.ZodNumber;
    parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    rootId: z.ZodString;
    depth: z.ZodDefault<z.ZodNumber>;
    isRoot: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type CatalogFolder = z.infer<typeof catalogFolderSchema>;
export declare const renameCatalogFolderInputSchema: z.ZodObject<{
    folderId: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
export type RenameCatalogFolderInput = z.infer<typeof renameCatalogFolderInputSchema>;
export declare const renameCatalogFolderResultSchema: z.ZodObject<{
    folder: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        assetCount: z.ZodNumber;
        offlineCount: z.ZodNumber;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        rootId: z.ZodString;
        depth: z.ZodDefault<z.ZodNumber>;
        isRoot: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type RenameCatalogFolderResult = z.infer<typeof renameCatalogFolderResultSchema>;
export declare const createCatalogFolderInputSchema: z.ZodObject<{
    parentFolderId: z.ZodString;
}, z.core.$strip>;
export type CreateCatalogFolderInput = z.infer<typeof createCatalogFolderInputSchema>;
export declare const moveCatalogFolderInputSchema: z.ZodObject<{
    sourceFolderId: z.ZodString;
    targetFolderId: z.ZodString;
}, z.core.$strip>;
export type MoveCatalogFolderInput = z.infer<typeof moveCatalogFolderInputSchema>;
export declare const moveCatalogFolderResultSchema: z.ZodObject<{
    folder: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        assetCount: z.ZodNumber;
        offlineCount: z.ZodNumber;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        rootId: z.ZodString;
        depth: z.ZodDefault<z.ZodNumber>;
        isRoot: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type MoveCatalogFolderResult = z.infer<typeof moveCatalogFolderResultSchema>;
export declare const catalogFolderSyncReportSchema: z.ZodObject<{
    discovered: z.ZodNumber;
    offline: z.ZodNumber;
}, z.core.$strip>;
export type CatalogFolderSyncReport = z.infer<typeof catalogFolderSyncReportSchema>;
export declare const unregisterCatalogFolderInputSchema: z.ZodObject<{
    folderId: z.ZodString;
}, z.core.$strip>;
export type UnregisterCatalogFolderInput = z.infer<typeof unregisterCatalogFolderInputSchema>;
export declare const unregisterCatalogFolderReportSchema: z.ZodObject<{
    folderId: z.ZodString;
    assetCount: z.ZodNumber;
}, z.core.$strip>;
export type UnregisterCatalogFolderReport = z.infer<typeof unregisterCatalogFolderReportSchema>;
export declare const relinkCatalogFolderResultSchema: z.ZodObject<{
    folder: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        assetCount: z.ZodNumber;
        offlineCount: z.ZodNumber;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        rootId: z.ZodString;
        depth: z.ZodDefault<z.ZodNumber>;
        isRoot: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
    matched: z.ZodNumber;
    discovered: z.ZodNumber;
    offline: z.ZodNumber;
}, z.core.$strip>;
export type RelinkCatalogFolderResult = z.infer<typeof relinkCatalogFolderResultSchema>;
export declare const catalogAlbumSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    assetCount: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export type CatalogAlbum = z.infer<typeof catalogAlbumSchema>;
export declare const saveCatalogAlbumInputSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
}, z.core.$strip>;
export type SaveCatalogAlbumInput = z.infer<typeof saveCatalogAlbumInputSchema>;
export declare const updateCatalogAlbumAssetsInputSchema: z.ZodObject<{
    albumId: z.ZodString;
    assetIds: z.ZodArray<z.ZodString>;
    mode: z.ZodEnum<{
        add: "add";
        remove: "remove";
    }>;
}, z.core.$strip>;
export type UpdateCatalogAlbumAssetsInput = z.infer<typeof updateCatalogAlbumAssetsInputSchema>;
export declare const catalogSmartCollectionSchema: z.ZodObject<{
    id: z.ZodEnum<{
        recent: "recent";
        favorites: "favorites";
        unrated: "unrated";
        unanalyzed: "unanalyzed";
        generated: "generated";
        "to-review": "to-review";
    }>;
    assetCount: z.ZodNumber;
}, z.core.$strip>;
export type CatalogSmartCollection = z.infer<typeof catalogSmartCollectionSchema>;
export declare const moveCatalogAssetsInputSchema: z.ZodObject<{
    assetIds: z.ZodArray<z.ZodString>;
    targetFolderId: z.ZodString;
    includeCompanions: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type MoveCatalogAssetsInput = z.infer<typeof moveCatalogAssetsInputSchema>;
export declare const moveCatalogAssetsReportSchema: z.ZodObject<{
    operationId: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
    }>;
    total: z.ZodNumber;
    moved: z.ZodNumber;
    skipped: z.ZodNumber;
    rolledBack: z.ZodBoolean;
    files: z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        fileName: z.ZodString;
        previousFileName: z.ZodString;
    }, z.core.$strip>>;
    errorCode: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type MoveCatalogAssetsReport = z.infer<typeof moveCatalogAssetsReportSchema>;
export declare const copyCatalogAssetsInputSchema: z.ZodObject<{
    assetIds: z.ZodArray<z.ZodString>;
    targetFolderId: z.ZodString;
    includeCompanions: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type CopyCatalogAssetsInput = z.infer<typeof copyCatalogAssetsInputSchema>;
export declare const copyCatalogAssetsReportSchema: z.ZodObject<{
    operationId: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
    }>;
    total: z.ZodNumber;
    copied: z.ZodNumber;
    rolledBack: z.ZodBoolean;
    files: z.ZodArray<z.ZodObject<{
        sourceAssetId: z.ZodString;
        assetId: z.ZodString;
        fileName: z.ZodString;
    }, z.core.$strip>>;
    errorCode: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type CopyCatalogAssetsReport = z.infer<typeof copyCatalogAssetsReportSchema>;
export declare const catalogCompanionPreviewSchema: z.ZodObject<{
    files: z.ZodArray<z.ZodObject<{
        fileName: z.ZodString;
        kind: z.ZodEnum<{
            raw: "raw";
            jpeg: "jpeg";
            xmp: "xmp";
        }>;
        assetId: z.ZodNullable<z.ZodString>;
        bytes: z.ZodNumber;
    }, z.core.$strip>>;
    totalBytes: z.ZodNumber;
}, z.core.$strip>;
export type CatalogCompanionPreview = z.infer<typeof catalogCompanionPreviewSchema>;
export declare const catalogCompanionPreviewInputSchema: z.ZodArray<z.ZodString>;
export declare const renameCatalogAssetInputSchema: z.ZodObject<{
    assetId: z.ZodString;
    fileName: z.ZodString;
}, z.core.$strip>;
export type RenameCatalogAssetInput = z.infer<typeof renameCatalogAssetInputSchema>;
export declare const renameCatalogAssetReportSchema: z.ZodObject<{
    operationId: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
    }>;
    assetId: z.ZodString;
    previousFileName: z.ZodString;
    fileName: z.ZodString;
    rolledBack: z.ZodBoolean;
    errorCode: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type RenameCatalogAssetReport = z.infer<typeof renameCatalogAssetReportSchema>;
export declare const renameCatalogAssetsInputSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        fileName: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RenameCatalogAssetsInput = z.infer<typeof renameCatalogAssetsInputSchema>;
export declare const renameCatalogAssetsReportSchema: z.ZodObject<{
    total: z.ZodNumber;
    succeeded: z.ZodNumber;
    failed: z.ZodNumber;
    reports: z.ZodArray<z.ZodObject<{
        operationId: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            failed: "failed";
        }>;
        assetId: z.ZodString;
        previousFileName: z.ZodString;
        fileName: z.ZodString;
        rolledBack: z.ZodBoolean;
        errorCode: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RenameCatalogAssetsReport = z.infer<typeof renameCatalogAssetsReportSchema>;
export declare const catalogAssetRemovalInputSchema: z.ZodObject<{
    assetIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type CatalogAssetRemovalInput = z.infer<typeof catalogAssetRemovalInputSchema>;
export declare const catalogAssetRemovalReportSchema: z.ZodObject<{
    operationId: z.ZodString;
    kind: z.ZodEnum<{
        remove: "remove";
        trash: "trash";
    }>;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        partial: "partial";
    }>;
    total: z.ZodNumber;
    succeeded: z.ZodNumber;
    failed: z.ZodNumber;
    failures: z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        errorCode: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CatalogAssetRemovalReport = z.infer<typeof catalogAssetRemovalReportSchema>;
export declare const fileOperationHistoryItemSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        remove: "remove";
        trash: "trash";
        move: "move";
        copy: "copy";
        rename: "rename";
    }>;
    status: z.ZodEnum<{
        executing: "executing";
        completed: "completed";
        failed: "failed";
        partial: "partial";
        planned: "planned";
        compensating: "compensating";
        undoing: "undoing";
        undone: "undone";
        compensation_failed: "compensation_failed";
    }>;
    total: z.ZodNumber;
    succeeded: z.ZodNumber;
    failed: z.ZodNumber;
    fileNames: z.ZodArray<z.ZodString>;
    createdAt: z.ZodNumber;
    completedAt: z.ZodNullable<z.ZodNumber>;
    errorCode: z.ZodNullable<z.ZodString>;
    undoable: z.ZodBoolean;
}, z.core.$strip>;
export type FileOperationHistoryItem = z.infer<typeof fileOperationHistoryItemSchema>;
export declare const undoFileOperationInputSchema: z.ZodObject<{
    operationId: z.ZodString;
}, z.core.$strip>;
export type UndoFileOperationInput = z.infer<typeof undoFileOperationInputSchema>;
export declare const undoFileOperationReportSchema: z.ZodObject<{
    operationId: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
    }>;
    total: z.ZodNumber;
    undone: z.ZodNumber;
    rolledBack: z.ZodBoolean;
    files: z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        previousFileName: z.ZodString;
        fileName: z.ZodString;
    }, z.core.$strip>>;
    errorCode: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type UndoFileOperationReport = z.infer<typeof undoFileOperationReportSchema>;
export declare const updateCatalogMetadataInputSchema: z.ZodObject<{
    assetIds: z.ZodArray<z.ZodString>;
    rating: z.ZodOptional<z.ZodNumber>;
    labelColor: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        red: "red";
        yellow: "yellow";
        green: "green";
        blue: "blue";
        purple: "purple";
    }>>>;
    flag: z.ZodOptional<z.ZodEnum<{
        rejected: "rejected";
        picked: "picked";
        unflagged: "unflagged";
    }>>;
    favorite: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type UpdateCatalogMetadataInput = z.infer<typeof updateCatalogMetadataInputSchema>;
export declare const updateCatalogTagsInputSchema: z.ZodObject<{
    assetIds: z.ZodArray<z.ZodString>;
    addTags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    removeTagIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type UpdateCatalogTagsInput = z.input<typeof updateCatalogTagsInputSchema>;
export declare const catalogSnapshotSchema: z.ZodObject<{
    assets: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        folderId: z.ZodString;
        directoryId: z.ZodOptional<z.ZodString>;
        fileName: z.ZodString;
        format: z.ZodString;
        sizeBytes: z.ZodNumber;
        modifiedAt: z.ZodNumber;
        rating: z.ZodNumber;
        labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
            red: "red";
            yellow: "yellow";
            green: "green";
            blue: "blue";
            purple: "purple";
        }>>>;
        flag: z.ZodDefault<z.ZodEnum<{
            rejected: "rejected";
            picked: "picked";
            unflagged: "unflagged";
        }>>;
        favorite: z.ZodBoolean;
        offline: z.ZodBoolean;
        tags: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
        }, z.core.$strip>>;
        thumbnailUrl: z.ZodString;
        previewUrl: z.ZodString;
        workflow: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            key: z.ZodString;
            name: z.ZodString;
            stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
            }, z.core.$strip>>>;
            members: z.ZodArray<z.ZodObject<{
                stageId: z.ZodString;
                stageName: z.ZodString;
                variant: z.ZodString;
                asset: z.ZodObject<{
                    id: z.ZodString;
                    folderId: z.ZodString;
                    directoryId: z.ZodOptional<z.ZodString>;
                    fileName: z.ZodString;
                    format: z.ZodString;
                    sizeBytes: z.ZodNumber;
                    modifiedAt: z.ZodNumber;
                    rating: z.ZodNumber;
                    labelColor: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                        red: "red";
                        yellow: "yellow";
                        green: "green";
                        blue: "blue";
                        purple: "purple";
                    }>>>;
                    flag: z.ZodDefault<z.ZodEnum<{
                        rejected: "rejected";
                        picked: "picked";
                        unflagged: "unflagged";
                    }>>;
                    favorite: z.ZodBoolean;
                    offline: z.ZodBoolean;
                    tags: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        name: z.ZodString;
                    }, z.core.$strip>>;
                    thumbnailUrl: z.ZodString;
                    previewUrl: z.ZodString;
                }, z.core.$strip>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        workflowConflict: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    importedCount: z.ZodNumber;
}, z.core.$strip>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export declare const providerKindSchema: z.ZodEnum<{
    "openai-compatible": "openai-compatible";
    "nanobanana-compatible": "nanobanana-compatible";
    "acedata-nano-banana": "acedata-nano-banana";
}>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export declare const providerPurposeSchema: z.ZodEnum<{
    vision: "vision";
    generation: "generation";
}>;
export type ProviderPurpose = z.infer<typeof providerPurposeSchema>;
export declare const providerCustomHeadersSchema: z.ZodRecord<z.ZodString, z.ZodString>;
export declare const providerProfileSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    kind: z.ZodEnum<{
        "openai-compatible": "openai-compatible";
        "nanobanana-compatible": "nanobanana-compatible";
        "acedata-nano-banana": "acedata-nano-banana";
    }>;
    purpose: z.ZodEnum<{
        vision: "vision";
        generation: "generation";
    }>;
    baseUrl: z.ZodString;
    modelId: z.ZodString;
    requestTimeoutMs: z.ZodDefault<z.ZodNumber>;
    retryCount: z.ZodDefault<z.ZodNumber>;
    customHeaders: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    hasCredential: z.ZodBoolean;
    enabled: z.ZodBoolean;
    isDefault: z.ZodOptional<z.ZodBoolean>;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export declare const saveProviderProfileInputSchema: z.ZodObject<{
    name: z.ZodString;
    enabled: z.ZodBoolean;
    kind: z.ZodEnum<{
        "openai-compatible": "openai-compatible";
        "nanobanana-compatible": "nanobanana-compatible";
        "acedata-nano-banana": "acedata-nano-banana";
    }>;
    purpose: z.ZodEnum<{
        vision: "vision";
        generation: "generation";
    }>;
    baseUrl: z.ZodString;
    modelId: z.ZodString;
    requestTimeoutMs: z.ZodDefault<z.ZodNumber>;
    retryCount: z.ZodDefault<z.ZodNumber>;
    customHeaders: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    isDefault: z.ZodOptional<z.ZodBoolean>;
    id: z.ZodOptional<z.ZodString>;
    apiKey: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SaveProviderProfileInput = z.input<typeof saveProviderProfileInputSchema>;
export declare const connectionTestSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    message: z.ZodString;
    latencyMs: z.ZodNumber;
}, z.core.$strip>;
export type ConnectionTest = z.infer<typeof connectionTestSchema>;
/** A durable, multi-step photo editing workflow planned from natural language. */
export declare const taskKindSchema: z.ZodEnum<{
    generation: "generation";
    analysis: "analysis";
    "collection-analysis": "collection-analysis";
    agent: "agent";
    export: "export";
}>;
export declare const taskBatchInputSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        generation: "generation";
        analysis: "analysis";
        "collection-analysis": "collection-analysis";
        agent: "agent";
        export: "export";
    }>;
    batchId: z.ZodString;
}, z.core.$strip>;
export type TaskBatchInput = z.infer<typeof taskBatchInputSchema>;
export declare const taskStatusSchema: z.ZodEnum<{
    paused: "paused";
    completed: "completed";
    failed: "failed";
    canceled: "canceled";
    draft: "draft";
    queued: "queued";
    preparing: "preparing";
    uploading: "uploading";
    processing: "processing";
    downloading: "downloading";
    saving: "saving";
}>;
export declare const persistedTaskSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        generation: "generation";
        analysis: "analysis";
        "collection-analysis": "collection-analysis";
        agent: "agent";
        export: "export";
    }>;
    assetId: z.ZodNullable<z.ZodString>;
    assetFileName: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        paused: "paused";
        completed: "completed";
        failed: "failed";
        canceled: "canceled";
        draft: "draft";
        queued: "queued";
        preparing: "preparing";
        uploading: "uploading";
        processing: "processing";
        downloading: "downloading";
        saving: "saving";
    }>;
    position: z.ZodNumber;
    progress: z.ZodNumber;
    attempt: z.ZodNumber;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    result: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    errorCode: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export type PersistedTask = z.infer<typeof persistedTaskSchema>;
export declare const taskListCursorSchema: z.ZodObject<{
    sortGroup: z.ZodNumber;
    position: z.ZodNumber;
    createdAt: z.ZodNumber;
    id: z.ZodString;
}, z.core.$strip>;
export type TaskListCursor = z.infer<typeof taskListCursorSchema>;
export declare const listTaskPageInputSchema: z.ZodObject<{
    includeBatchMembers: z.ZodDefault<z.ZodBoolean>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        sortGroup: z.ZodNumber;
        position: z.ZodNumber;
        createdAt: z.ZodNumber;
        id: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type ListTaskPageInput = z.input<typeof listTaskPageInputSchema>;
export declare const taskPageSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            generation: "generation";
            analysis: "analysis";
            "collection-analysis": "collection-analysis";
            agent: "agent";
            export: "export";
        }>;
        assetId: z.ZodNullable<z.ZodString>;
        assetFileName: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            paused: "paused";
            completed: "completed";
            failed: "failed";
            canceled: "canceled";
            draft: "draft";
            queued: "queued";
            preparing: "preparing";
            uploading: "uploading";
            processing: "processing";
            downloading: "downloading";
            saving: "saving";
        }>;
        position: z.ZodNumber;
        progress: z.ZodNumber;
        attempt: z.ZodNumber;
        payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        result: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        errorCode: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$strip>>;
    totalCount: z.ZodNumber;
    queuedCount: z.ZodNumber;
    pausedCount: z.ZodNumber;
    activeCount: z.ZodNumber;
    failedCount: z.ZodNumber;
    failedGenerationCount: z.ZodNumber;
    nextCursor: z.ZodNullable<z.ZodObject<{
        sortGroup: z.ZodNumber;
        position: z.ZodNumber;
        createdAt: z.ZodNumber;
        id: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TaskPage = z.infer<typeof taskPageSchema>;
export declare const moveQueuedTaskInputSchema: z.ZodObject<{
    taskId: z.ZodString;
    direction: z.ZodUnion<readonly [z.ZodLiteral<-1>, z.ZodLiteral<1>]>;
}, z.core.$strip>;
export type MoveQueuedTaskInput = z.infer<typeof moveQueuedTaskInputSchema>;
export declare const retryFailedGenerationTasksInputSchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type RetryFailedGenerationTasksInput = z.input<typeof retryFailedGenerationTasksInputSchema>;
export declare const retryFailedGenerationTasksReportSchema: z.ZodObject<{
    retried: z.ZodNumber;
    remaining: z.ZodNumber;
}, z.core.$strip>;
export type RetryFailedGenerationTasksReport = z.infer<typeof retryFailedGenerationTasksReportSchema>;
export declare const enqueueTaskInputSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        generation: "generation";
        analysis: "analysis";
        "collection-analysis": "collection-analysis";
        agent: "agent";
        export: "export";
    }>;
    assetId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    payload: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type EnqueueTaskInput = z.infer<typeof enqueueTaskInputSchema>;
export declare const taskIdSchema: z.ZodString;
export declare const deleteTasksInputSchema: z.ZodObject<{
    scope: z.ZodEnum<{
        batch: "batch";
        task: "task";
        below: "below";
        "below-batches": "below-batches";
        "batch-unfinished": "batch-unfinished";
        all: "all";
        unfinished: "unfinished";
    }>;
    taskId: z.ZodOptional<z.ZodString>;
    orderedTaskIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type DeleteTasksInput = z.input<typeof deleteTasksInputSchema>;
export declare const taskBatchActionInputSchema: z.ZodObject<{
    taskId: z.ZodString;
    action: z.ZodEnum<{
        pause: "pause";
        resume: "resume";
        cancel: "cancel";
        retry: "retry";
    }>;
}, z.core.$strip>;
export type TaskBatchActionInput = z.input<typeof taskBatchActionInputSchema>;
export declare const agentStepKindSchema: z.ZodEnum<{
    move: "move";
    export: "export";
    select: "select";
    deduplicate: "deduplicate";
    rank: "rank";
    rate: "rate";
    adjust: "adjust";
    generate: "generate";
    delete: "delete";
}>;
export type AgentStepKind = z.infer<typeof agentStepKindSchema>;
export declare const agentSelectionRuleSchema: z.ZodObject<{
    assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    limit: z.ZodOptional<z.ZodNumber>;
    minimumQuality: z.ZodOptional<z.ZodNumber>;
    excludeBlurry: z.ZodDefault<z.ZodBoolean>;
    excludeNearDuplicates: z.ZodDefault<z.ZodBoolean>;
    ranking: z.ZodDefault<z.ZodEnum<{
        custom: "custom";
        quality: "quality";
        aesthetic: "aesthetic";
        sharpness: "sharpness";
        composition: "composition";
    }>>;
    rankingInstruction: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type AgentSelectionRule = z.infer<typeof agentSelectionRuleSchema>;
export declare const agentPerAssetPromptSchema: z.ZodObject<{
    assetId: z.ZodString;
    prompt: z.ZodString;
    negativePrompt: z.ZodDefault<z.ZodString>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type AgentPerAssetPrompt = z.infer<typeof agentPerAssetPromptSchema>;
export declare const agentStepSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        move: "move";
        export: "export";
        select: "select";
        deduplicate: "deduplicate";
        rank: "rank";
        rate: "rate";
        adjust: "adjust";
        generate: "generate";
        delete: "delete";
    }>;
    instruction: z.ZodDefault<z.ZodString>;
    selection: z.ZodOptional<z.ZodObject<{
        assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        limit: z.ZodOptional<z.ZodNumber>;
        minimumQuality: z.ZodOptional<z.ZodNumber>;
        excludeBlurry: z.ZodDefault<z.ZodBoolean>;
        excludeNearDuplicates: z.ZodDefault<z.ZodBoolean>;
        ranking: z.ZodDefault<z.ZodEnum<{
            custom: "custom";
            quality: "quality";
            aesthetic: "aesthetic";
            sharpness: "sharpness";
            composition: "composition";
        }>>;
        rankingInstruction: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    rating: z.ZodOptional<z.ZodNumber>;
    prompt: z.ZodDefault<z.ZodString>;
    perAssetPrompts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        prompt: z.ZodString;
        negativePrompt: z.ZodDefault<z.ZodString>;
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    providerProfileId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    templateId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    outputDirectory: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    targetFolderId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    confirm: z.ZodDefault<z.ZodBoolean>;
    style: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export declare const agentTaskPayloadSchema: z.ZodObject<{
    instruction: z.ZodString;
    globalPrompt: z.ZodDefault<z.ZodString>;
    selection: z.ZodPreprocess<z.ZodObject<{
        assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        limit: z.ZodOptional<z.ZodNumber>;
        minimumQuality: z.ZodOptional<z.ZodNumber>;
        excludeBlurry: z.ZodDefault<z.ZodBoolean>;
        excludeNearDuplicates: z.ZodDefault<z.ZodBoolean>;
        ranking: z.ZodDefault<z.ZodEnum<{
            custom: "custom";
            quality: "quality";
            aesthetic: "aesthetic";
            sharpness: "sharpness";
            composition: "composition";
        }>>;
        rankingInstruction: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>, unknown>;
    perAssetPrompts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        prompt: z.ZodString;
        negativePrompt: z.ZodDefault<z.ZodString>;
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            move: "move";
            export: "export";
            select: "select";
            deduplicate: "deduplicate";
            rank: "rank";
            rate: "rate";
            adjust: "adjust";
            generate: "generate";
            delete: "delete";
        }>;
        instruction: z.ZodDefault<z.ZodString>;
        selection: z.ZodOptional<z.ZodObject<{
            assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            limit: z.ZodOptional<z.ZodNumber>;
            minimumQuality: z.ZodOptional<z.ZodNumber>;
            excludeBlurry: z.ZodDefault<z.ZodBoolean>;
            excludeNearDuplicates: z.ZodDefault<z.ZodBoolean>;
            ranking: z.ZodDefault<z.ZodEnum<{
                custom: "custom";
                quality: "quality";
                aesthetic: "aesthetic";
                sharpness: "sharpness";
                composition: "composition";
            }>>;
            rankingInstruction: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>>;
        assetIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        rating: z.ZodOptional<z.ZodNumber>;
        prompt: z.ZodDefault<z.ZodString>;
        perAssetPrompts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            assetId: z.ZodString;
            prompt: z.ZodString;
            negativePrompt: z.ZodDefault<z.ZodString>;
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>>;
        providerProfileId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        templateId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        outputDirectory: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        targetFolderId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        confirm: z.ZodDefault<z.ZodBoolean>;
        style: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    outputDirectory: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    confirmHighImpact: z.ZodDefault<z.ZodBoolean>;
    dryRun: z.ZodDefault<z.ZodBoolean>;
    planVersion: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type AgentTaskPayload = z.infer<typeof agentTaskPayloadSchema>;
export declare const agentTaskResultSchema: z.ZodObject<{
    selectedAssetIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    removedAssetIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    ratedAssetIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    generatedResultIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    movedAssetIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    completedSteps: z.ZodDefault<z.ZodArray<z.ZodString>>;
    skippedSteps: z.ZodDefault<z.ZodArray<z.ZodString>>;
    warnings: z.ZodDefault<z.ZodArray<z.ZodString>>;
    dryRun: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type AgentTaskResult = z.infer<typeof agentTaskResultSchema>;
export declare const updateQueuedGenerationTaskInputSchema: z.ZodObject<{
    taskId: z.ZodString;
    prompt: z.ZodString;
}, z.core.$strip>;
export type UpdateQueuedGenerationTaskInput = z.infer<typeof updateQueuedGenerationTaskInputSchema>;
export declare const updateQueuedGenerationTasksInputSchema: z.ZodObject<{
    taskIds: z.ZodArray<z.ZodString>;
    providerProfileId: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
    templateId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    templateVersion: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    resize: z.ZodOptional<z.ZodObject<{
        batchId: z.ZodString;
        assetId: z.ZodString;
        count: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type UpdateQueuedGenerationTasksInput = z.infer<typeof updateQueuedGenerationTasksInputSchema>;
export declare const resizeQueuedGenerationBatchInputSchema: z.ZodObject<{
    batchId: z.ZodString;
    assetId: z.ZodString;
    count: z.ZodNumber;
}, z.core.$strip>;
export type ResizeQueuedGenerationBatchInput = z.infer<typeof resizeQueuedGenerationBatchInputSchema>;
export declare const normalizedRegionSchema: z.ZodObject<{
    kind: z.ZodLiteral<"normalized_box">;
    x: z.ZodNumber;
    y: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export declare const analysisIssueSchema: z.ZodObject<{
    type: z.ZodString;
    severity: z.ZodNumber;
    confidence: z.ZodNumber;
    description: z.ZodString;
}, z.core.$strip>;
export declare const adjustmentSuggestionSchema: z.ZodObject<{
    parameter: z.ZodString;
    value: z.ZodNumber;
    unit: z.ZodString;
    confidence: z.ZodNumber;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const generativeActionSchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodEnum<{
        remove_object: "remove_object";
        replace_background: "replace_background";
        relight: "relight";
        outpaint: "outpaint";
        repair: "repair";
        recompose: "recompose";
        other: "other";
    }>;
    target: z.ZodString;
    region: z.ZodNullable<z.ZodObject<{
        kind: z.ZodLiteral<"normalized_box">;
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    instruction: z.ZodString;
    preserve: z.ZodArray<z.ZodString>;
    risk: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
    confidence: z.ZodNumber;
    enabled: z.ZodBoolean;
}, z.core.$strip>;
export declare const catalogAnnotationSchema: z.ZodObject<{
    shortDescription: z.ZodString;
    longDescription: z.ZodString;
    scenes: z.ZodArray<z.ZodString>;
    subjects: z.ZodArray<z.ZodString>;
    objects: z.ZodArray<z.ZodString>;
    mood: z.ZodArray<z.ZodString>;
    colors: z.ZodArray<z.ZodString>;
    keywords: z.ZodArray<z.ZodString>;
    ocrText: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const analysisResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"1.0">;
    summary: z.ZodString;
    report: z.ZodString;
    quality: z.ZodObject<{
        overallScore: z.ZodNumber;
        issues: z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            severity: z.ZodNumber;
            confidence: z.ZodNumber;
            description: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    adjustments: z.ZodObject<{
        global: z.ZodArray<z.ZodObject<{
            parameter: z.ZodString;
            value: z.ZodNumber;
            unit: z.ZodString;
            confidence: z.ZodNumber;
            reason: z.ZodString;
        }, z.core.$strip>>;
        local: z.ZodArray<z.ZodObject<{
            parameter: z.ZodString;
            value: z.ZodNumber;
            unit: z.ZodString;
            confidence: z.ZodNumber;
            reason: z.ZodString;
            target: z.ZodString;
            region: z.ZodNullable<z.ZodObject<{
                kind: z.ZodLiteral<"normalized_box">;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    generativeActions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodEnum<{
            remove_object: "remove_object";
            replace_background: "replace_background";
            relight: "relight";
            outpaint: "outpaint";
            repair: "repair";
            recompose: "recompose";
            other: "other";
        }>;
        target: z.ZodString;
        region: z.ZodNullable<z.ZodObject<{
            kind: z.ZodLiteral<"normalized_box">;
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
        }, z.core.$strip>>;
        instruction: z.ZodString;
        preserve: z.ZodArray<z.ZodString>;
        risk: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        confidence: z.ZodNumber;
        enabled: z.ZodBoolean;
    }, z.core.$strip>>;
    catalog: z.ZodObject<{
        shortDescription: z.ZodString;
        longDescription: z.ZodString;
        scenes: z.ZodArray<z.ZodString>;
        subjects: z.ZodArray<z.ZodString>;
        objects: z.ZodArray<z.ZodString>;
        mood: z.ZodArray<z.ZodString>;
        colors: z.ZodArray<z.ZodString>;
        keywords: z.ZodArray<z.ZodString>;
        ocrText: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>;
    generationRecommendation: z.ZodObject<{
        recommended: z.ZodBoolean;
        templateId: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export declare const promptTemplateSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    category: z.ZodString;
    body: z.ZodString;
    exampleId: z.ZodEnum<{
        portrait: "portrait";
        street: "street";
        coast: "coast";
        none: "none";
    }>;
    version: z.ZodNumber;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
export declare const savePromptTemplateInputSchema: z.ZodObject<{
    description: z.ZodString;
    name: z.ZodString;
    category: z.ZodString;
    body: z.ZodString;
    id: z.ZodOptional<z.ZodString>;
    exampleId: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        portrait: "portrait";
        street: "street";
        coast: "coast";
        none: "none";
    }>>>;
}, z.core.$strip>;
export type SavePromptTemplateInput = Omit<z.infer<typeof savePromptTemplateInputSchema>, 'exampleId'> & {
    exampleId?: PromptTemplate['exampleId'];
};
export declare const analysisRevisionSchema: z.ZodObject<{
    id: z.ZodString;
    assetId: z.ZodString;
    providerProfileId: z.ZodString;
    result: z.ZodObject<{
        schemaVersion: z.ZodLiteral<"1.0">;
        summary: z.ZodString;
        report: z.ZodString;
        quality: z.ZodObject<{
            overallScore: z.ZodNumber;
            issues: z.ZodArray<z.ZodObject<{
                type: z.ZodString;
                severity: z.ZodNumber;
                confidence: z.ZodNumber;
                description: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        adjustments: z.ZodObject<{
            global: z.ZodArray<z.ZodObject<{
                parameter: z.ZodString;
                value: z.ZodNumber;
                unit: z.ZodString;
                confidence: z.ZodNumber;
                reason: z.ZodString;
            }, z.core.$strip>>;
            local: z.ZodArray<z.ZodObject<{
                parameter: z.ZodString;
                value: z.ZodNumber;
                unit: z.ZodString;
                confidence: z.ZodNumber;
                reason: z.ZodString;
                target: z.ZodString;
                region: z.ZodNullable<z.ZodObject<{
                    kind: z.ZodLiteral<"normalized_box">;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        generativeActions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            type: z.ZodEnum<{
                remove_object: "remove_object";
                replace_background: "replace_background";
                relight: "relight";
                outpaint: "outpaint";
                repair: "repair";
                recompose: "recompose";
                other: "other";
            }>;
            target: z.ZodString;
            region: z.ZodNullable<z.ZodObject<{
                kind: z.ZodLiteral<"normalized_box">;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
            }, z.core.$strip>>;
            instruction: z.ZodString;
            preserve: z.ZodArray<z.ZodString>;
            risk: z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>;
            confidence: z.ZodNumber;
            enabled: z.ZodBoolean;
        }, z.core.$strip>>;
        catalog: z.ZodObject<{
            shortDescription: z.ZodString;
            longDescription: z.ZodString;
            scenes: z.ZodArray<z.ZodString>;
            subjects: z.ZodArray<z.ZodString>;
            objects: z.ZodArray<z.ZodString>;
            mood: z.ZodArray<z.ZodString>;
            colors: z.ZodArray<z.ZodString>;
            keywords: z.ZodArray<z.ZodString>;
            ocrText: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>;
        generationRecommendation: z.ZodObject<{
            recommended: z.ZodBoolean;
            templateId: z.ZodNullable<z.ZodString>;
            reason: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export type AnalysisRevision = z.infer<typeof analysisRevisionSchema>;
export declare const listAnalysisInputSchema: z.ZodObject<{
    assetId: z.ZodString;
}, z.core.$strip>;
export declare const listGenerationResultsInputSchema: z.ZodObject<{
    assetId: z.ZodString;
}, z.core.$strip>;
export declare const analysisTaskPayloadSchema: z.ZodObject<{
    batchId: z.ZodOptional<z.ZodString>;
    locale: z.ZodOptional<z.ZodEnum<{
        "zh-CN": "zh-CN";
        "en-US": "en-US";
    }>>;
    providerProfileId: z.ZodString;
    mode: z.ZodDefault<z.ZodEnum<{
        catalog: "catalog";
        full: "full";
    }>>;
}, z.core.$strip>;
export declare const collectionAnalysisTaskPayloadSchema: z.ZodObject<{
    locale: z.ZodOptional<z.ZodEnum<{
        "zh-CN": "zh-CN";
        "en-US": "en-US";
    }>>;
    providerProfileId: z.ZodString;
    assetIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const collectionAnalysisReportSchema: z.ZodObject<{
    summary: z.ZodString;
    groups: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        assetIds: z.ZodArray<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strip>>;
    keepAssetIds: z.ZodArray<z.ZodString>;
    reviewAssetIds: z.ZodArray<z.ZodString>;
    recommendations: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type CollectionAnalysisReport = z.infer<typeof collectionAnalysisReportSchema>;
export declare const generationTaskPayloadSchema: z.ZodObject<{
    sourceResultId: z.ZodOptional<z.ZodString>;
    submissionId: z.ZodOptional<z.ZodString>;
    providerProfileId: z.ZodString;
    batchId: z.ZodString;
    prompt: z.ZodString;
    templateId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    templateVersion: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    resultIndex: z.ZodNumber;
    storageMode: z.ZodDefault<z.ZodEnum<{
        managed: "managed";
        portable: "portable";
    }>>;
    analysisRevisionId: z.ZodOptional<z.ZodString>;
    disabledActionIds: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
    userInstruction: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>;
export declare const generationResultSchema: z.ZodObject<{
    id: z.ZodString;
    assetId: z.ZodString;
    batchId: z.ZodString;
    version: z.ZodNumber;
    fileName: z.ZodString;
    resultUrl: z.ZodString;
    prompt: z.ZodString;
    providerProfileId: z.ZodString;
    templateId: z.ZodNullable<z.ZodString>;
    templateVersion: z.ZodNullable<z.ZodNumber>;
    storageMode: z.ZodDefault<z.ZodEnum<{
        managed: "managed";
        portable: "portable";
    }>>;
    reviewState: z.ZodEnum<{
        rejected: "rejected";
        undecided: "undecided";
        accepted: "accepted";
        preferred: "preferred";
    }>;
    createdAt: z.ZodNumber;
}, z.core.$strip>;
export type GenerationResult = z.infer<typeof generationResultSchema>;
export declare const trashedGenerationResultSchema: z.ZodObject<{
    id: z.ZodString;
    assetId: z.ZodString;
    batchId: z.ZodString;
    version: z.ZodNumber;
    fileName: z.ZodString;
    resultUrl: z.ZodString;
    prompt: z.ZodString;
    providerProfileId: z.ZodString;
    templateId: z.ZodNullable<z.ZodString>;
    templateVersion: z.ZodNullable<z.ZodNumber>;
    storageMode: z.ZodDefault<z.ZodEnum<{
        managed: "managed";
        portable: "portable";
    }>>;
    reviewState: z.ZodEnum<{
        rejected: "rejected";
        undecided: "undecided";
        accepted: "accepted";
        preferred: "preferred";
    }>;
    createdAt: z.ZodNumber;
    trashedAt: z.ZodNumber;
}, z.core.$strip>;
export type TrashedGenerationResult = z.infer<typeof trashedGenerationResultSchema>;
export declare const generationResultIdInputSchema: z.ZodObject<{
    resultId: z.ZodString;
}, z.core.$strip>;
export type GenerationResultIdInput = z.infer<typeof generationResultIdInputSchema>;
export declare const generationTrashSummarySchema: z.ZodObject<{
    resultCount: z.ZodNumber;
    totalBytes: z.ZodNumber;
    missingFiles: z.ZodNumber;
    unsafePaths: z.ZodNumber;
}, z.core.$strip>;
export type GenerationTrashSummary = z.infer<typeof generationTrashSummarySchema>;
export declare const emptyGenerationTrashReportSchema: z.ZodObject<{
    total: z.ZodNumber;
    purged: z.ZodNumber;
    missingFiles: z.ZodNumber;
    failed: z.ZodNumber;
    freedBytes: z.ZodNumber;
}, z.core.$strip>;
export type EmptyGenerationTrashReport = z.infer<typeof emptyGenerationTrashReportSchema>;
export declare const updateGenerationResultReviewInputSchema: z.ZodObject<{
    resultId: z.ZodString;
    reviewState: z.ZodEnum<{
        rejected: "rejected";
        undecided: "undecided";
        accepted: "accepted";
        preferred: "preferred";
    }>;
}, z.core.$strip>;
export type UpdateGenerationResultReviewInput = z.infer<typeof updateGenerationResultReviewInputSchema>;
export declare const exportGenerationResultsInputSchema: z.ZodObject<{
    resultIds: z.ZodArray<z.ZodString>;
    presetId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type ExportGenerationResultsInput = z.infer<typeof exportGenerationResultsInputSchema>;
export declare const exportPresetSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    format: z.ZodEnum<{
        jpeg: "jpeg";
        original: "original";
        png: "png";
    }>;
    quality: z.ZodNumber;
    maxDimension: z.ZodNullable<z.ZodNumber>;
    conflictPolicy: z.ZodEnum<{
        "auto-rename": "auto-rename";
        skip: "skip";
    }>;
    namingPattern: z.ZodString;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
}, z.core.$strip>;
export type ExportPreset = z.infer<typeof exportPresetSchema>;
export declare const exportTaskPayloadSchema: z.ZodObject<{
    resultIds: z.ZodArray<z.ZodString>;
    destinationDirectory: z.ZodString;
    preset: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        format: z.ZodEnum<{
            jpeg: "jpeg";
            original: "original";
            png: "png";
        }>;
        quality: z.ZodNumber;
        maxDimension: z.ZodNullable<z.ZodNumber>;
        conflictPolicy: z.ZodEnum<{
            "auto-rename": "auto-rename";
            skip: "skip";
        }>;
        namingPattern: z.ZodString;
        createdAt: z.ZodNumber;
        updatedAt: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ExportTaskPayload = z.infer<typeof exportTaskPayloadSchema>;
export declare const saveExportPresetInputSchema: z.ZodObject<{
    name: z.ZodString;
    format: z.ZodEnum<{
        jpeg: "jpeg";
        original: "original";
        png: "png";
    }>;
    conflictPolicy: z.ZodEnum<{
        "auto-rename": "auto-rename";
        skip: "skip";
    }>;
    namingPattern: z.ZodString;
    id: z.ZodOptional<z.ZodString>;
    quality: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    maxDimension: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
}, z.core.$strip>;
export type SaveExportPresetInput = z.input<typeof saveExportPresetInputSchema>;
export declare const exportReportSchema: z.ZodObject<{
    id: z.ZodNullable<z.ZodString>;
    canceled: z.ZodBoolean;
    total: z.ZodNumber;
    succeeded: z.ZodNumber;
    failed: z.ZodNumber;
    files: z.ZodArray<z.ZodObject<{
        resultId: z.ZodString;
        fileName: z.ZodString;
    }, z.core.$strip>>;
    failures: z.ZodArray<z.ZodObject<{
        resultId: z.ZodString;
        errorCode: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ExportReport = z.infer<typeof exportReportSchema>;
export declare const imageCacheStatsSchema: z.ZodObject<{
    files: z.ZodNumber;
    bytes: z.ZodNumber;
}, z.core.$strip>;
export type ImageCacheStats = z.infer<typeof imageCacheStatsSchema>;
export declare const pruneImageCacheInputSchema: z.ZodObject<{
    maxBytes: z.ZodNumber;
}, z.core.$strip>;
export * from './agent';
export interface DesktopApi {
    createAgentSession(input: {
        assetIds: string[];
    }): Promise<AgentSession>;
    getMcpStatus(): Promise<McpStatus>;
    setMcpEnabled(enabled: boolean): Promise<McpStatus>;
    listAgentSessions(): Promise<AgentSession[]>;
    getAgentSession(id: string): Promise<AgentSession>;
    deleteAgentSession(id: string): Promise<void>;
    sendAgentMessage(input: {
        sessionId: string;
        text: string;
        assetIds?: string[];
    }): Promise<AgentSession>;
    controlAgentSession(input: {
        sessionId: string;
        action: 'pause' | 'resume' | 'cancel' | 'approve' | 'reject';
        callId?: string;
    }): Promise<AgentSession>;
    getFileWorkflowConfig(): Promise<FileWorkflowConfig>;
    saveFileWorkflowConfig(input: FileWorkflowConfig): Promise<FileWorkflowConfig>;
    previewFileWorkflow(input: FileWorkflowScope & {
        config: FileWorkflowConfig;
    }): Promise<CatalogAssetPage>;
    onCatalogChanged(listener: () => void): () => void;
    onMenuCommand(listener: (command: MenuCommand) => void): () => void;
    updateMenuState(state: MenuState): void;
    getAppInfo(): Promise<AppInfo>;
    getAppSettings(): Promise<AppSettings>;
    saveAppSettings(input: AppSettings): Promise<AppSettings>;
    getDiagnosticSnapshot(): Promise<DiagnosticSnapshot>;
    exportDiagnosticSnapshot(): Promise<DiagnosticExportResult>;
    runLibraryIntegrityCheck(): Promise<LibraryIntegrityReport>;
    backupDatabase(): Promise<DatabaseBackupResult>;
    backupLibrary(): Promise<LibraryBackupResult>;
    verifyLibraryBackup(): Promise<LibraryBackupVerificationResult>;
    restoreLibraryBackup(): Promise<LibraryRestoreResult>;
    getWorkspaceSession(): Promise<WorkspaceSession>;
    saveWorkspaceSession(session: WorkspaceSession): Promise<WorkspaceSession>;
    listCatalogAssets(): Promise<CatalogAsset[]>;
    listCatalogAssetPage(input: ListCatalogAssetsInput): Promise<CatalogAssetPage>;
    listCatalogFolders(): Promise<CatalogFolder[]>;
    listCatalogTags(): Promise<CatalogTag[]>;
    deleteCatalogTag(tagId: DeleteCatalogTagInput): Promise<void>;
    listCatalogAlbums(): Promise<CatalogAlbum[]>;
    listCatalogSmartCollections(): Promise<CatalogSmartCollection[]>;
    saveCatalogAlbum(input: SaveCatalogAlbumInput): Promise<CatalogAlbum>;
    deleteCatalogAlbum(albumId: string): Promise<void>;
    updateCatalogAlbumAssets(input: UpdateCatalogAlbumAssetsInput): Promise<CatalogAlbum>;
    updateCatalogMetadata(input: UpdateCatalogMetadataInput): Promise<CatalogAsset[]>;
    updateCatalogTags(input: UpdateCatalogTagsInput): Promise<CatalogTag[]>;
    moveCatalogAssets(input: MoveCatalogAssetsInput): Promise<MoveCatalogAssetsReport>;
    copyCatalogAssets(input: CopyCatalogAssetsInput): Promise<CopyCatalogAssetsReport>;
    previewCatalogCompanions(assetIds: string[]): Promise<CatalogCompanionPreview>;
    renameCatalogAsset(input: RenameCatalogAssetInput): Promise<RenameCatalogAssetReport>;
    renameCatalogAssets(input: RenameCatalogAssetsInput): Promise<RenameCatalogAssetsReport>;
    removeCatalogAssets(input: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport>;
    trashCatalogAssets(input: CatalogAssetRemovalInput): Promise<CatalogAssetRemovalReport>;
    listFileOperationHistory(): Promise<FileOperationHistoryItem[]>;
    undoFileOperation(input: UndoFileOperationInput): Promise<UndoFileOperationReport>;
    importFolders(): Promise<CatalogSnapshot | null>;
    relinkCatalogFolder(folderId: string): Promise<RelinkCatalogFolderResult | null>;
    renameCatalogFolder(input: RenameCatalogFolderInput): Promise<RenameCatalogFolderResult>;
    createCatalogFolder(input: CreateCatalogFolderInput): Promise<RenameCatalogFolderResult>;
    moveCatalogFolder(input: MoveCatalogFolderInput): Promise<MoveCatalogFolderResult>;
    synchronizeCatalogFolder(folderId: string): Promise<CatalogFolderSyncReport>;
    revealCatalogFolder(folderId: string): Promise<boolean>;
    unregisterCatalogFolder(input: UnregisterCatalogFolderInput): Promise<UnregisterCatalogFolderReport>;
    revealCatalogAsset(assetId: string): Promise<boolean>;
    getFileDetails(assetId: string): Promise<FileDetails>;
    openAssetExternally(assetId: string): Promise<void>;
    linkImageDirectory(assetId: string): Promise<void>;
    openImages(paths?: string[]): Promise<QuickViewSession | null>;
    takePendingOpenImages(): Promise<QuickViewSession | null>;
    onOpenImages(listener: (session: QuickViewSession) => void): () => void;
    getDroppedFilePaths(files: File[]): string[];
    listProviderProfiles(): Promise<ProviderProfile[]>;
    saveProviderProfile(input: SaveProviderProfileInput): Promise<ProviderProfile>;
    deleteProviderProfile(profileId: string): Promise<void>;
    testProviderConnection(input: SaveProviderProfileInput): Promise<ConnectionTest>;
    listTaskPage(input: ListTaskPageInput): Promise<TaskPage>;
    listTaskBatch(input: TaskBatchInput): Promise<PersistedTask[]>;
    getTask(taskId: string): Promise<PersistedTask | null>;
    enqueueTask(input: EnqueueTaskInput): Promise<PersistedTask>;
    cancelTask(taskId: string): Promise<PersistedTask>;
    deleteTasks(input: DeleteTasksInput): Promise<{
        deletedIds: string[];
    }>;
    actOnTaskBatch(input: TaskBatchActionInput): Promise<number>;
    pauseTask(taskId: string): Promise<PersistedTask>;
    resumeTask(taskId: string): Promise<PersistedTask>;
    retryTask(taskId: string): Promise<PersistedTask>;
    retryFailedTasks(): Promise<number>;
    moveQueuedTask(input: MoveQueuedTaskInput): Promise<PersistedTask>;
    retryFailedGenerationTasks(input?: RetryFailedGenerationTasksInput): Promise<RetryFailedGenerationTasksReport>;
    updateQueuedGenerationTask(input: UpdateQueuedGenerationTaskInput): Promise<PersistedTask>;
    updateQueuedGenerationTasks(input: UpdateQueuedGenerationTasksInput): Promise<PersistedTask[]>;
    resizeQueuedGenerationBatch(input: ResizeQueuedGenerationBatchInput): Promise<PersistedTask[]>;
    listPromptTemplates(): Promise<PromptTemplate[]>;
    savePromptTemplate(input: SavePromptTemplateInput): Promise<PromptTemplate>;
    archivePromptTemplate(templateId: string): Promise<void>;
    listAnalysisRevisions(assetId: string): Promise<AnalysisRevision[]>;
    listGenerationResults(assetId: string): Promise<GenerationResult[]>;
    listTrashedGenerationResults(assetId: string): Promise<TrashedGenerationResult[]>;
    trashGenerationResult(input: GenerationResultIdInput): Promise<TrashedGenerationResult>;
    restoreGenerationResult(input: GenerationResultIdInput): Promise<GenerationResult>;
    getGenerationTrashSummary(): Promise<GenerationTrashSummary>;
    emptyGenerationTrash(): Promise<EmptyGenerationTrashReport>;
    updateGenerationResultReview(input: UpdateGenerationResultReviewInput): Promise<GenerationResult>;
    revealGenerationResult(resultId: string): Promise<boolean>;
    exportGenerationResults(input: ExportGenerationResultsInput): Promise<PersistedTask | null>;
    revealExportDestination(taskId: string): Promise<boolean>;
    listExportPresets(): Promise<ExportPreset[]>;
    saveExportPreset(input: SaveExportPresetInput): Promise<ExportPreset>;
    deleteExportPreset(presetId: string): Promise<void>;
    getImageCacheStats(): Promise<ImageCacheStats>;
    pruneImageCache(input: z.input<typeof pruneImageCacheInputSchema>): Promise<{
        removedFiles: number;
        removedBytes: number;
    }>;
}
