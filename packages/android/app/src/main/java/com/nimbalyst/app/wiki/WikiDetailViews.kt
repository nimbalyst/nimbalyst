package com.nimbalyst.app.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Sell
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors

/** A typed page's type and fields, read-only, above its body. Mirrors iOS `WikiPageHeader`. */
@Composable
fun WikiPageHeader(typeName: String, fields: List<WikiField>, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(true) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(NimbalystColors.background)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(enabled = fields.isNotEmpty()) { expanded = !expanded },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Sell, contentDescription = null, tint = NimbalystColors.primary, modifier = Modifier.size(16.dp))
            Text(typeName, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = NimbalystColors.primary, modifier = Modifier.weight(1f))
            if (fields.isNotEmpty()) {
                Icon(
                    Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = NimbalystColors.primary,
                    modifier = Modifier.size(18.dp).rotate(if (expanded) 0f else -90f),
                )
            }
        }
        if (expanded) {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (field in fields) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(field.name, fontSize = 12.sp, color = NimbalystColors.textFaint, modifier = Modifier.width(96.dp))
                            Text(field.value.displayText, fontSize = 13.sp, color = NimbalystColors.text)
                        }
                    }
                }
            }
        }
    }
}

/** A table type's rows, as display strings in [header] order (the `id` column is the row id). */
fun WikiTable.displayRows(): List<List<String>> = rows.map { row ->
    header.map { column ->
        if (column == "id") row.id else row.fields.firstOrNull { it.name == column }?.value?.displayText.orEmpty()
    }
}

private val COLUMN_WIDTH = 160.dp

/** Rows of a table type or a CSV file, read-only. Mirrors iOS `WikiTableView`. */
@Composable
fun WikiTableView(header: List<String>, rows: List<List<String>>, malformed: Boolean, modifier: Modifier = Modifier) {
    when {
        malformed -> Notice(stringResource(R.string.wiki_table_malformed), modifier)
        header.isEmpty() -> Notice(stringResource(R.string.wiki_table_empty), modifier)
        else -> Box(modifier = modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
            LazyColumn(modifier = Modifier.width(COLUMN_WIDTH * header.size + 32.dp).padding(horizontal = 16.dp, vertical = 8.dp)) {
                item {
                    TableRow(header, header.size, bold = true)
                    HorizontalDivider(color = NimbalystColors.border)
                }
                itemsIndexed(rows) { _, row -> TableRow(row, header.size, bold = false) }
            }
        }
    }
}

@Composable
private fun TableRow(cells: List<String>, columns: Int, bold: Boolean) {
    SelectionContainer {
        Row(modifier = Modifier.padding(vertical = 6.dp)) {
            for (column in 0 until columns) {
                Text(
                    cells.getOrElse(column) { "" },
                    fontSize = if (bold) 12.sp else 13.sp,
                    fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (bold) NimbalystColors.textFaint else NimbalystColors.text,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(COLUMN_WIDTH).padding(end = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun Notice(text: String, modifier: Modifier) {
    Box(modifier = modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
    }
}
