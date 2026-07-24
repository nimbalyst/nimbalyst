---
description: Create or modify Prisma-based data models for Nimbalyst's DataModelLM visual editor
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
---

# /datamodel Command

Creates data model files compatible with Nimbalyst's DataModelLM visual editor. DataModelLM displays entity-relationship diagrams with a visual canvas for designing database schemas.

## File Format

DataModelLM uses **Prisma schema format** with a special metadata comment header for viewport and layout information.

### Required Header

Every DataModelLM file MUST start with a `@nimbalyst` metadata comment on the first line:

```prisma
// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{},"entityViewMode":"standard"}
```

This metadata stores:
- `viewport`: Camera position and zoom level for the visual editor
- `positions`: Entity node positions on the canvas (auto-populated by the editor)
- `entityViewMode`: Display mode ("standard" or "compact")

### Basic Structure

```prisma
// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{},"entityViewMode":"standard"}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id])
  authorId  Int
  createdAt DateTime @default(now())
}
```

## File Location

- **Extension**: `.prisma`
- **Location**: Workspace root or any subdirectory (e.g., `models/`, `schema/`)
- **Naming**: Use descriptive names like `schema.prisma`, `database.prisma`, or `[project-name].prisma`

## Supported Field Types

### Scalar Types
- `Int` - Integer values
- `BigInt` - Large integers
- `Float` - Floating point numbers
- `Decimal` - Exact decimal numbers
- `String` - Text values
- `Boolean` - True/false values
- `DateTime` - Date and time
- `Json` - JSON data
- `Bytes` - Binary data

### Type Modifiers
- `?` - Optional field (e.g., `String?`)
- `[]` - Array/list (e.g., `Post[]`)

### Field Attributes
- `@id` - Primary key
- `@unique` - Unique constraint
- `@default(value)` - Default value
- `@updatedAt` - Auto-update timestamp
- `@relation` - Define relationships

## Relationship Patterns

### One-to-Many (Most Common)

```prisma
model User {
  id    Int    @id @default(autoincrement())
  posts Post[]
}

model Post {
  id       Int  @id @default(autoincrement())
  author   User @relation(fields: [authorId], references: [id])
  authorId Int
}
```

### One-to-One

```prisma
model User {
  id      Int      @id @default(autoincrement())
  profile Profile?
}

model Profile {
  id     Int  @id @default(autoincrement())
  user   User @relation(fields: [userId], references: [id])
  userId Int  @unique
}
```

### Many-to-Many (Implicit)

```prisma
model Post {
  id         Int        @id @default(autoincrement())
  categories Category[]
}

model Category {
  id    Int    @id @default(autoincrement())
  posts Post[]
}
```

### Many-to-Many (Explicit with Join Table)

```prisma
model Post {
  id         Int              @id @default(autoincrement())
  categories CategoriesOnPosts[]
}

model Category {
  id    Int              @id @default(autoincrement())
  posts CategoriesOnPosts[]
}

model CategoriesOnPosts {
  post       Post     @relation(fields: [postId], references: [id])
  postId     Int
  category   Category @relation(fields: [categoryId], references: [id])
  categoryId Int
  assignedAt DateTime @default(now())

  @@id([postId, categoryId])
}
```

### Self-Relations

```prisma
model User {
  id          Int     @id @default(autoincrement())
  name        String
  followers   User[]  @relation("UserFollows")
  following   User[]  @relation("UserFollows")
}
```

## Database Providers

Supported `datasource.provider` values:
- `postgresql` - PostgreSQL (recommended)
- `mysql` - MySQL
- `sqlite` - SQLite
- `sqlserver` - SQL Server
- `mongodb` - MongoDB
- `cockroachdb` - CockroachDB

## Best Practices

1. **Always include the @nimbalyst header** - Required for the visual editor
2. **Use meaningful model names** - PascalCase, singular (e.g., `User` not `Users`)
3. **Include timestamps** - Add `createdAt` and `updatedAt` to most models
4. **Define explicit relations** - Always specify `@relation` with `fields` and `references`
5. **Use appropriate types** - Choose the most specific type for your data

## Instructions for Creating Data Models

When the user asks to create a data model:

1. **Understand the domain** - Ask about entities, their properties, and relationships
2. **Identify primary entities** - Start with core models (User, Product, Order, etc.)
3. **Map relationships** - Determine how entities relate (one-to-many, many-to-many)
4. **Choose field types** - Select appropriate Prisma types for each property
5. **Add constraints** - Include `@unique`, `@default`, and other attributes as needed
6. **Create the file** - Write to a `.prisma` file with the required header

## Example Prompts and Responses

**User**: "Create a data model for a blog"

**Response**: Create a file with User, Post, Comment, and Category models with appropriate relationships.

**User**: "Add a tags system to the blog"

**Response**: Add a Tag model and a many-to-many relationship with Post.

**User**: "I need a data model for an e-commerce site"

**Response**: Create models for User, Product, Category, Order, OrderItem, Cart, CartItem, Address, and Payment with appropriate relationships and fields.
